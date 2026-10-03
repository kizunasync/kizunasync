/// <reference types="bun" />
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IStoreLocator } from '../ports/store-locator'

// MARK: - createTempDatabase

/**
 * A locator over a database file nothing else holds, for headless tests against
 * the real engine. The kernel opens that file and owns it; the test opens
 * `bun:sqlite` on `path` itself when it wants to inspect rows outside the port.
 */
export interface ITempDatabase {
  driver: IStoreLocator

  /** The file the kernel opens. It does not exist until the engine creates it. */
  path: string

  /** Delete the file and the journal SQLite leaves beside it. Idempotent. */
  remove(): void
}

/**
 * A fresh temp file per call, so two clients built in one test process never
 * share a store. `name` is a readable prefix for the file; the unique suffix is
 * added either way.
 */
export function createTempDatabase(name = 'kizunasync-test'): ITempDatabase {
  const path = join(tmpdir(), `${name}-${randomUUID()}.sqlite`)

  return {
    driver: { databasePath: path },
    path,
    remove() {
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        rmSync(`${path}${suffix}`, { force: true })
      }
    },
  }
}
