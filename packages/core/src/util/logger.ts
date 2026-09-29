/**
 * Diagnostics go through an `ILogger`, never `console.*`. Chosen at init:
 *
 *   - omit it            → silent (quiet by default);
 *   - `{ level: 'debug' }` → the built-in adze logger (emoji + timestamp + the
 *                          `kizunasync:<area>` namespace), useful in the browser;
 *   - `{ logger }`       → a caller sink (pino, winston, a console shim for
 *                          React Native…).
 *
 * Configure once at app boot and pass the result to `createKizunaSync` (`{ logging }`)
 * and `createSupabaseTransfer` so the pipeline shares one logger.
 */

import adze, { setup } from 'adze'

// MARK: - Logger

export type TLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export interface ILogger {
  debug(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void

  /** A namespaced child, e.g. `log.child('attachments')` → `kizunasync:attachments`. */
  child(namespace: string): ILogger
}

export interface ILoggerOptions {
  /** Minimum level emitted. Default 'silent'. 'silent' disables logging. */
  level?: TLogLevel

  /**
   * Bring your own sink. When set, the built-in loggers are bypassed and every
   * Kizuna log is forwarded to this logger verbatim.
   */
  logger?: ILogger
}

const noop = (): void => undefined

/** Drops everything: the default sink, and the result of level 'silent'. */
export const noopLogger: ILogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => noopLogger,
}

// MARK: - adze backend

function adzeLogger(namespaces: string[]): ILogger {
  const sealed = adze.withEmoji.timestamp.ns(...namespaces).seal()

  return {
    debug: (message, meta) => void (meta === undefined ? sealed.debug(message) : sealed.debug(message, meta)),
    info: (message, meta) => void (meta === undefined ? sealed.info(message) : sealed.info(message, meta)),
    warn: (message, meta) => void (meta === undefined ? sealed.warn(message) : sealed.warn(message, meta)),
    error: (message, meta) => void (meta === undefined ? sealed.error(message) : sealed.error(message, meta)),
    child: (namespace) => adzeLogger([...namespaces, namespace]),
  }
}

/** The built-in adze logger. activeLevel is global to adze, set here at init. */
export function createLogger(options: ILoggerOptions = {}): ILogger {
  if (options.logger !== undefined) {
    return options.logger
  }
  const level = options.level ?? 'silent'

  if (level === 'silent') {
    return noopLogger
  }
  setup({ activeLevel: level })

  return adzeLogger(['kizunasync'])
}

// MARK: - Universal console backend

const LEVEL_RANK: Record<Exclude<TLogLevel, 'silent'>, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * A dependency-free, console-backed ILogger that runs on ANY JS runtime,
 * including React Native, where adze's browser bias can misbehave. Use it as the
 * `logger` you inject on native: `createConsoleLogger('debug')`.
 */
export function createConsoleLogger(level: TLogLevel = 'silent', namespaces: string[] = ['kizunasync']): ILogger {
  if (level === 'silent') {
    return noopLogger
  }
  const threshold = LEVEL_RANK[level]
  const tag = `[${namespaces.join(':')}]`
  const at =
    (rank: number, sink: (...args: unknown[]) => void) =>
    (message: string, meta?: unknown): void => {
      if (rank < threshold) {
        return
      }
      if (meta === undefined) {
        sink(tag, message)
      } else {
        sink(tag, message, meta)
      }
    }
  return {
    debug: at(LEVEL_RANK.debug, console.debug ?? console.log),
    info: at(LEVEL_RANK.info, console.info ?? console.log),
    warn: at(LEVEL_RANK.warn, console.warn),
    error: at(LEVEL_RANK.error, console.error),
    child: (namespace) => createConsoleLogger(level, [...namespaces, namespace]),
  }
}
