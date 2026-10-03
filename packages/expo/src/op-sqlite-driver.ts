import type { IStoreLocator } from '@kizunasync/core'
import { createStoreLocator } from './store-locator'

/**
 * The opt-in `@op-engineering/op-sqlite` store locator. It names the database
 * file the Rust kernel opens, and `verifyOpSqliteDriver` is the one function
 * here that opens a live op-sqlite handle, for the device gate a release build
 * runs.
 *
 * The peer is optional, so this module has its own entry point: `import
 * { openOpSqliteDriver } from '@kizunasync/expo/op-sqlite'` keeps Metro from
 * resolving it for every consumer.
 */

// MARK: - Types

/**
 * What an op-sqlite statement binds. The kernel owns the store, so this shape
 * reaches op-sqlite only through the device gate below.
 */
export type TOpSqliteValue = string | number | null

/**
 * The synchronous shape `verifyOpSqliteDriver` runs its five checks through,
 * adapted from an open op-sqlite database by {@link probeHandle}.
 */
export interface IOpSqliteSyncDriver {
  execSync(sql: string): void
  runSync(sql: string, params: TOpSqliteValue[]): unknown
  getAllSync<T>(sql: string, params: TOpSqliteValue[]): T[]
  getFirstSync<T>(sql: string, params: TOpSqliteValue[]): T | null
}

export interface IOpSqliteResult {
  rows?: unknown[]
  rowsAffected?: number
}

export interface IOpSqliteDb {
  executeSync(sql: string, params?: TOpSqliteValue[]): IOpSqliteResult
  execute?(sql: string, params?: TOpSqliteValue[]): Promise<IOpSqliteResult>
  close?(): void
}

export interface IOpSqliteModule {
  open(options: { name: string; location?: string }): IOpSqliteDb
}

export type TOpenOpSqliteOptions = {
  /**
   * The op-sqlite module `verifyOpSqliteDriver` opens its live handle with, injected
   * by tests. Default: dynamic import of `@op-engineering/op-sqlite`.
   */
  module?: IOpSqliteModule

  /**
   * Absolute directory for the database file, as a path or a `file://` URI.
   * Forwarded to op-sqlite as `location`, and joined with `name` to make the
   * path the locator reports.
   */
  location?: string
}

// MARK: - open

/**
 * op-sqlite takes a filesystem path, while Expo's file-system APIs hand out
 * `file://` URIs, so a caller may pass either. The scheme and a trailing slash
 * come off once here, and every use downstream is the plain directory.
 */
function toDirectoryPath(location: string | undefined): string | undefined {
  return location?.replace(/^file:\/\//, '').replace(/\/$/, '')
}

/**
 * Open op-sqlite as a store locator for `createKizunaSync` (native only).
 *
 * `location` is required, because the locator's whole job is to name the file
 * the Rust kernel opens. It takes either an absolute directory path or the
 * `file://` URI Expo's file-system APIs hand out: the scheme and a trailing
 * slash come off, so op-sqlite opens a plain directory and the locator reports
 * `<location>/<name>`. The locator carries NetInfo and AppState as its platform
 * ports. Nothing loads the peer here, since the kernel holds the only connection;
 * {@link verifyOpSqliteDriver} is where a real handle is opened.
 */
export function openOpSqliteDriver(name: string, options: Pick<TOpenOpSqliteOptions, 'location'> = {}): IStoreLocator {
  const location = toDirectoryPath(options.location)

  if (location === undefined || location.length === 0) {
    throw new Error(
      'openOpSqliteDriver requires options.location so the Rust engine can open the same file',
    )
  }
  return createStoreLocator(`${location}/${name}`)
}

function openLiveOpSqliteDriver(
  name: string,
  options: TOpenOpSqliteOptions,
  mod: IOpSqliteModule,
): { driver: IOpSqliteSyncDriver; close: () => void } {
  const db = mod.open({ name, location: toDirectoryPath(options.location) })

  return {
    driver: probeHandle(db),
    close: () => {
      db.close?.()
    },
  }
}

async function loadOpSqliteModule(): Promise<IOpSqliteModule> {
  const specifier = '@op-engineering/op-sqlite'

  try {
    return (await import(specifier)) as unknown as IOpSqliteModule
  } catch (error) {
    throw new Error(
      `verifyOpSqliteDriver: failed to load ${specifier}. Install the optional peer ` +
        `@op-engineering/op-sqlite and rebuild the native app (${String(error)})`,
    )
  }
}

/**
 * Adapt an open op-sqlite database to the synchronous shape the device gate
 * drives. Nothing else opens one: the kernel holds the store's only connection.
 */
export function probeHandle(db: IOpSqliteDb): IOpSqliteSyncDriver {
  return {
    execSync: (sql) => {
      db.executeSync(sql)
    },
    runSync: (sql, params) => db.executeSync(sql, params),
    getAllSync: <T>(sql: string, params: TOpSqliteValue[]): T[] =>
      (db.executeSync(sql, params).rows ?? []) as T[],
    getFirstSync: <T>(sql: string, params: TOpSqliteValue[]): T | null => {
      const rows = db.executeSync(sql, params).rows ?? []

      return rows.length > 0 ? (rows[0] as T) : null
    },
  }
}

// MARK: - Device verification gate

export type TOpSqliteVerifyResult = {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; detail?: string }>
}

/**
 * Run the op-sqlite capability gate that release builds must pass on a physical
 * device, or at least on a native binary host rather than web. The five checks
 * are open, create table, insert, select, delete, and they run on a live handle
 * this function opens and the kernel never sees. Inject `module` in unit tests;
 * on device call without injection.
 */
export async function verifyOpSqliteDriver(
  name = 'kizunasync-op-sqlite-verify',
  options: TOpenOpSqliteOptions = {},
): Promise<TOpSqliteVerifyResult> {
  const checks: TOpSqliteVerifyResult['checks'] = []
  let close: (() => void) | null = null

  try {
    const mod = options.module ?? (await loadOpSqliteModule())
    const live = openLiveOpSqliteDriver(name, options, mod)

    close = live.close
    const driver = live.driver

    checks.push({ name: 'open', ok: true })

    driver.execSync('CREATE TABLE IF NOT EXISTS _kizunasync_verify (id TEXT PRIMARY KEY, v INTEGER)')
    checks.push({ name: 'create_table', ok: true })

    driver.runSync('INSERT OR REPLACE INTO _kizunasync_verify(id, v) VALUES (?, ?)', ['one', 1])
    checks.push({ name: 'insert', ok: true })

    const rows = driver.getAllSync<{ id: string; v: number }>(
      'SELECT id, v FROM _kizunasync_verify WHERE id = ?',
      ['one'],
    )
    const selectOk = rows.length === 1 && rows[0]!.v === 1

    checks.push({
      name: 'select',
      ok: selectOk,
      detail: selectOk ? undefined : `unexpected rows ${JSON.stringify(rows)}`,
    })

    driver.runSync('DELETE FROM _kizunasync_verify WHERE id = ?', ['one'])
    checks.push({ name: 'delete', ok: true })

    const ok = checks.every((c) => c.ok)

    return { ok, checks }
  } catch (error) {
    checks.push({ name: 'error', ok: false, detail: String(error) })

    return { ok: false, checks }
  } finally {
    close?.()
  }
}
