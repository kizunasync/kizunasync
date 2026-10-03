import { expect, test } from '@playwright/test'
import { PAGE_PATH, waitForParity } from './harness'

// MARK: - The query parity vectors, in a browser

/**
 * The fourth runner of `packages/core/src/query/parity-vectors.json`: the shipped
 * TypeScript builder, `apply_query` in Rust and the NAPI transport are the other
 * three. The TypeScript semantics stay the oracle, so a disagreement here is a
 * Rust or bridge bug on wasm, never a vector edit.
 */

/** The floor every sibling runner asserts, so no runner can silently shrink. */
const MINIMUM_VECTORS = 60

const PARITY_TIMEOUT_MS = 9 * 60 * 1000

test('every local query parity vector agrees on the wasm engine', async ({ page }) => {
  const crashes: string[] = []

  page.on('pageerror', (error) => {
    crashes.push(error.message)
  })

  await page.goto(`${PAGE_PATH}?run=parity`)
  const summary = await waitForParity(page, PARITY_TIMEOUT_MS)

  expect(summary.failures).toEqual([])
  expect(summary.failed).toBe(0)
  expect(summary.vectors).toBeGreaterThanOrEqual(MINIMUM_VECTORS)
  expect(summary.passed).toBe(summary.vectors)
  // The oracle-integrity assertion the sibling runners make: a duplicated name would hide one vector behind another.
  expect(new Set(summary.names).size).toBe(summary.vectors)
  expect(crashes).toEqual([])
})
