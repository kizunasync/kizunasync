/**
 * One page, two drivers, two names, two engines. Each has to get the OPFS pool at
 * full durability and keep its own rows. An app that opens a second database is
 * ordinary; `apps/demo` does that with a database per pane.
 *
 * The two share no pool. Each driver runs its engine in its own dedicated worker,
 * and a worker is its own wasm instance, so each installs a sahpool of its own.
 * They also install into different places: `sahpool_directory` derives
 * `.kizunasync/<sanitized>-<hash8>` from the database name, and `sahpool_vfs_name`
 * derives the registered VFS name from the same hash. That stops two databases
 * opened by one instance from short-circuiting onto a single pool.
 *
 * The OPFS assertion below pins that layout so a change cannot put two databases
 * back in one directory.
 */

import { expect, test } from '@playwright/test'
import { insertRow, openEngine, PAGE_PATH, readPoolDirectories, readRowIds, readStoreKindOn } from './harness'

// MARK: - Two databases in one page

const FIRST = 'two-databases-first'

const SECOND = 'two-databases-second'

const TABLE = 'items'

/** The bucket the page's table config declares, so a row is inside it. */
const OWNER = 'u1'

const OPFS = { kind: 'opfs-sahpool', durability: 'full' }

/**
 * `sahpool_directory`: the name lowercased and reduced to `[a-z0-9._-]`, then an
 * FNV-1a suffix of the raw name. Both parts are asserted, the hash by shape, not
 * by value, so this does not restate the hash function.
 */
const POOL_DIRECTORY = /^two-databases-(first|second)-[0-9a-f]{8}$/

test('two databases in one page each get the OPFS pool and keep their own rows', async ({
  page,
}) => {
  await page.goto(PAGE_PATH)

  await openEngine(page, { name: FIRST, databasePath: FIRST, table: TABLE })
  await openEngine(page, { name: SECOND, databasePath: SECOND, table: TABLE })

  expect(await readStoreKindOn(page, FIRST)).toEqual(OPFS)
  expect(await readStoreKindOn(page, SECOND)).toEqual(OPFS)

  await insertRow(page, {
    name: FIRST,
    table: TABLE,
    columns: { id: 'first-row', user_id: OWNER, title: 'in the first database' },
  })
  await insertRow(page, {
    name: SECOND,
    table: TABLE,
    columns: { id: 'second-row', user_id: OWNER, title: 'in the second database' },
  })

  // Each store answers with its own row and nothing of the other's. That separates two databases from one database opened twice.
  expect(await readRowIds(page, FIRST, TABLE)).toEqual(['first-row'])
  expect(await readRowIds(page, SECOND, TABLE)).toEqual(['second-row'])

  // And on disk they are two pools, not one: the row separation above would also hold if the two shared a directory and merely kept separate SQLite files, so the layout is asserted directly.
  const directories = await readPoolDirectories(page)

  expect(directories).toHaveLength(2)

  for (const directory of directories) {
    expect(directory).toMatch(POOL_DIRECTORY)
  }
  expect(new Set(directories).size).toBe(2)
})
