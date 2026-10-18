import { expect, test } from '@playwright/test'
import { callEngine, closeEngines, insertRow, openEngine, openEngineExpectingFailure, PAGE_PATH, readRowIds, readStoreKind } from './harness'

// MARK: - The IndexedDB fallback

/**
 * Without the OPFS synchronous-access-handle pool the engine must open the relaxed
 * `IndexedDB` VFS. A browser that cannot give us handles still gets a database, at
 * relaxed durability. It does not drop to memory, and open does not fail.
 *
 * Two shapes, because a browser without OPFS produces two. `absent` is Safari
 * before 17, Firefox before 111 and every non-secure context: the method is not
 * there, so calling it throws synchronously. `rejecting` is a private-mode window,
 * where the call reaches the platform and fails with a `SecurityError`.
 * `refuse-opfs.ts` explains why the store cannot treat them as one.
 *
 * An OPFS that exists and fails for any other reason is no missing capability,
 * and IndexedDB would open a different, empty store, so that open fails with
 * `STORE_UNAVAILABLE`.
 */
const FALLBACK = { kind: 'relaxed-idb', durability: 'relaxed' }

test('the store falls back to relaxed-idb when getDirectory is absent', async ({ page }) => {
  await page.goto(`${PAGE_PATH}?opfs=absent`)
  await openEngine(page, { name: 'fallback-absent', databasePath: 'fallback-absent' })

  expect(await readStoreKind(page)).toEqual(FALLBACK)
})

test('the store falls back to relaxed-idb when getDirectory rejects with a SecurityError', async ({ page }) => {
  await page.goto(`${PAGE_PATH}?opfs=off`)
  await openEngine(page, { name: 'fallback-rejecting', databasePath: 'fallback-rejecting' })

  expect(await readStoreKind(page)).toEqual(FALLBACK)
})

test('the open fails with STORE_UNAVAILABLE when an OPFS that exists fails', async ({ page }) => {
  await page.goto(`${PAGE_PATH}?opfs=failing`)
  const failure = await openEngineExpectingFailure(page, { name: 'fallback-failing', databasePath: 'fallback-failing' })

  expect(failure?.code).toBe('STORE_UNAVAILABLE')

  const databases = await page.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name ?? '?'))

  expect(databases).not.toContain('relaxed-idb')
})

test('pending writes stay in IndexedDB when OPFS becomes available', async ({ page }) => {
  const name = 'fallback-then-opfs'

  await page.goto(`${PAGE_PATH}?opfs=absent`)
  await openEngine(page, { name, databasePath: name, table: 'items' })
  await insertRow(page, { name, table: 'items', columns: { id: 'offline-before-upgrade' } })
  await closeEngines(page)

  await page.goto(PAGE_PATH)
  await openEngine(page, { name, databasePath: name, table: 'items' })

  expect(await readStoreKind(page)).toEqual(FALLBACK)
  expect(await readRowIds(page, name, 'items')).toEqual(['offline-before-upgrade'])
  expect(await callEngine(page, 'outbox_depth')).toBe(1)
})

test('losing OPFS access refuses an empty fallback and preserves pending writes for recovery', async ({ page }) => {
  const name = 'opfs-permission-change'

  await page.goto(PAGE_PATH)
  await openEngine(page, { name, databasePath: name, table: 'items' })
  await insertRow(page, { name, table: 'items', columns: { id: 'offline-before-permission-change' } })
  await closeEngines(page)

  await page.goto(`${PAGE_PATH}?opfs=off`)
  const failure = await openEngineExpectingFailure(page, { name, databasePath: name })

  expect(failure?.code).toBe('STORE_UNAVAILABLE')
  expect(failure?.message).toContain('existing OPFS database is inaccessible')

  await page.goto(PAGE_PATH)
  await openEngine(page, { name, databasePath: name, table: 'items' })

  expect(await readRowIds(page, name, 'items')).toEqual(['offline-before-permission-change'])
  expect(await callEngine(page, 'outbox_depth')).toBe(1)
})
