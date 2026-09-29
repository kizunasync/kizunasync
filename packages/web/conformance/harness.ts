// MARK: - What the specs drive the conformance page with

/**
 * The page owns the engine; a spec only tells it which database to open and which
 * method to call. Keeping the `page.evaluate` bodies here means one typed view of
 * `window.__kizunasync` (declared by `run-corpus.ts`), not one cast per spec.
 */

import type { Page } from '@playwright/test'
import type { ICorpusSummary, IParitySummary } from './run-corpus'

export interface IStoreKind {
  kind: string
  durability: string
}

export const PAGE_PATH = '/run-corpus.html'

export async function openEngine(
  page: Page,
  options: { name: string; databasePath: string | null; table?: string },
): Promise<void> {
  await page.evaluate((opened) => window.__kizunasync.open(opened), options)
}

export interface IEngineFailure {
  code: string
  message: string
}

/**
 * `page.evaluate` rejects with a plain `Error`, dropping everything the typed
 * `TEngineError` carried, so the code is read inside the page and handed back as
 * data. `null` means the open unexpectedly succeeded, which a spec asserting a
 * refusal should fail on, not pass by default.
 */
export function openEngineExpectingFailure(
  page: Page,
  options: { name: string; databasePath: string | null; table?: string },
): Promise<IEngineFailure | null> {
  return page.evaluate(async (opened) => {
    try {
      await window.__kizunasync.open(opened)

      return null
    } catch (error) {
      const typed = error as { code?: unknown; message?: unknown }

      return {
        code: typeof typed.code === 'string' ? typed.code : '(no code)',
        message: typeof typed.message === 'string' ? typed.message : String(error),
      }
    }
  }, options)
}

export function callEngine(page: Page, method: string): Promise<unknown> {
  return page.evaluate((name) => window.__kizunasync.call(name), method)
}

/** The same call against one of several engines a page holds open. */
function callEngineOn(page: Page, name: string, method: string): Promise<unknown> {
  return page.evaluate((call) => window.__kizunasync.callOn(call.name, call.method), { name, method })
}

/**
 * The engine's own answer, so a fallback or a promotion is read from the store
 * that opened, not from the driver's cached capabilities.
 */
export async function readStoreKind(page: Page): Promise<IStoreKind> {
  const answer = (await callEngine(page, 'store_kind')) as Partial<IStoreKind> | null

  return { kind: String(answer?.kind), durability: String(answer?.durability) }
}

export async function readStoreKindOn(page: Page, name: string): Promise<IStoreKind> {
  const answer = (await callEngineOn(page, name, 'store_kind')) as Partial<IStoreKind> | null

  return { kind: String(answer?.kind), durability: String(answer?.durability) }
}

/**
 * Write one row into the named engine, then read the table back through the
 * engine's own `query`, so the round trip crosses the transport both ways.
 */
export async function insertRow(
  page: Page,
  options: { name: string; table: string; columns: Record<string, unknown> },
): Promise<void> {
  await page.evaluate(
    (write) => window.__kizunasync.insertOn(write.name, write.table, write.columns),
    options,
  )
}

/**
 * The `.kizunasync` directory names the sahpool installed, read from the page, not
 * from the store's own report: `getDirectory` is available off the worker, and
 * the layout is what a future change would break without a failing assertion.
 *
 * An absent `.kizunasync` returns `[]`; it does not throw. A store that never
 * installed the pool is what the layout assertion exists to catch. A raw
 * `NotFoundError` out of `getDirectoryHandle` would bury that under a stack
 * trace. The spec should fail on the expected directories.
 */
export async function readPoolDirectories(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const listing = root as unknown as {
      getDirectoryHandle: (name: string) => Promise<FileSystemDirectoryHandle>
    }
    let kizunasync: FileSystemDirectoryHandle

    try {
      kizunasync = await listing.getDirectoryHandle('.kizunasync')
    } catch {
      return []
    }
    const entries = kizunasync as unknown as { keys: () => AsyncIterable<string> }
    const names: string[] = []

    for await (const name of entries.keys()) {
      names.push(name)
    }
    return names.sort()
  })
}

export async function readRowIds(page: Page, name: string, table: string): Promise<string[]> {
  const rows = await page.evaluate(
    (read) => window.__kizunasync.callOn(read.name, 'query', { table: read.table, plan: { filters: [] } }),
    { name, table },
  )
  const listed = Array.isArray(rows) ? rows : rows === null ? [] : [rows]

  return listed.map((row) => String((row as { id?: unknown } | null)?.id ?? '<missing id>')).sort()
}

/**
 * Closes every engine the page holds and settles once their workers are gone, so
 * a spec may reopen the same database without racing the outgoing one.
 */
export async function closeEngines(page: Page): Promise<void> {
  await page.evaluate(() => window.__kizunasync.close())
}

export async function waitForCorpus(page: Page, timeout: number): Promise<ICorpusSummary> {
  await page.waitForFunction(() => window.__kizunasyncCorpus !== undefined, undefined, { timeout })

  return page.evaluate(() => window.__kizunasyncCorpus as ICorpusSummary)
}

export async function waitForParity(page: Page, timeout: number): Promise<IParitySummary> {
  await page.waitForFunction(() => window.__kizunasyncParity !== undefined, undefined, { timeout })

  return page.evaluate(() => window.__kizunasyncParity as IParitySummary)
}
