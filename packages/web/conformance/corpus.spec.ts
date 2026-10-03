/**
 * The manifest's executable half, replayed against the wasm engine through the
 * driver's transport. The counts are the ones `cargo run -p kizunasync-conformance` and
 * the NAPI lane report, so a browser-only divergence is a finding about the engine
 * on wasm, never a case to skip.
 */

import { expect, test } from '@playwright/test'
import { closeEngines, openEngine, PAGE_PATH, readRowIds, waitForCorpus } from './harness'

// MARK: - The golden corpus, in a browser

const EXECUTED_CASES = 49

/** `wakeup/002-wakeup-payload`, the one manifest entry with no transcript file. */
const SKIPPED_CASES = 1

const CORPUS_TIMEOUT_MS = 9 * 60 * 1000

test('the whole corpus passes through the web driver engine transport', async ({ page }) => {
  const crashes: string[] = []

  page.on('pageerror', (error) => {
    crashes.push(error.message)
  })

  await page.goto(`${PAGE_PATH}?run=corpus`)
  const summary = await waitForCorpus(page, CORPUS_TIMEOUT_MS)

  expect(summary.failures).toEqual([])
  expect(summary.failed).toBe(0)
  expect(summary.passed).toBe(EXECUTED_CASES)
  expect(summary.skipped).toBe(SKIPPED_CASES)
  expect(crashes).toEqual([])
})

// MARK: - Startup time

/**
 * Startup record for the browser lane: how long a cold page takes
 * from the driver open, which compiles the engine and installs the OPFS pool, to
 * the first query result coming back through the transport. It is printed, not
 * asserted: the number is a property of the machine that ran it, and a budget
 * pinned to this laptop would fail on a CI runner that is merely slower.
 */
const STARTUP_DATABASE = 'corpus-startup'

const STARTUP_TABLE = 'items'

test('records the open-to-first-query duration through the driver', async ({ page }) => {
  await page.goto(PAGE_PATH)

  const startedAt = Date.now()

  await openEngine(page, {
    name: STARTUP_DATABASE,
    databasePath: STARTUP_DATABASE,
    table: STARTUP_TABLE,
  })
  const rows = await readRowIds(page, STARTUP_DATABASE, STARTUP_TABLE)
  const elapsedMs = Date.now() - startedAt

  expect(rows).toEqual([])
  console.log(`startup: open to first query ${elapsedMs} ms`)
  await closeEngines(page)
})
