/**
 * kizunasync CLI: thin Node shim
 *
 * Resolves the Rust `kizunasync` binary and exec's it with the same argv. All command
 * logic (init, sync, wizard prompts) lives in `crates/kizunasync-cli`.
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultShimEntry, kizunasyncBinaryMissingMessage, resolveKizunaSyncBinary, type TResolveKizunaSyncBinaryOptions } from './resolve-binary'

type TExecResult = {
  status: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

type TExecFn = (
  binary: string,
  argv: string[],
  options: { stdio: 'inherit'; env: NodeJS.ProcessEnv; cwd: string },
) => TExecResult

type TExecKizunaSyncBinaryOptions = TResolveKizunaSyncBinaryOptions & {
  argv?: string[]
  cwd?: string
  exec?: TExecFn

  /** Test-only: the pack directory handed to the binary instead of the `pack/` this package ships. */
  packDir?: string
}

/**
 * Set on the child's environment. A shim that starts with it set was started by a shim, so
 * whatever it resolved is another copy of the shim rather than the native binary.
 */
const SHIM_GUARD_ENV = 'KSYNC_SHIM_ACTIVE'

const PACK_DIR_ENV = 'KSYNC_PACK_DIR'

const RECURSION_MESSAGE =
  'kizunasync: this Node shim was started by the kizunasync shim itself, so the binary it resolved is another copy of the shim, not the native CLI.\n\n' +
  'Point at the native binary:\n\n  export KSYNC_BIN=/path/to/kizunasync'

const spawnKizunaSyncBinary: TExecFn = (binary, argv, spawnOptions) => {
  const result = spawnSync(binary, argv, spawnOptions)

  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
  }
}

/** Maps a finished (or failed-to-spawn) child process onto the shim's own exit code. */
function execResultToExitCode(result: TExecResult, binary: string): number {
  if (result.error !== undefined) {
    process.stderr.write(`kizunasync: failed to run ${binary}: ${result.error.message}\n`)

    return 2
  }

  if (result.status === null) {
    return result.signal === 'SIGINT' ? 130 : 1
  }

  return result.status
}

/** The `pack/` directory the npm package ships beside `dist/`, which sits beside `src/` in the workspace too. */
function shippedPackDir(): string {
  return fileURLToPath(new URL('../pack', import.meta.url))
}

/**
 * The environment the native binary runs with: the recursion guard, and the shipped pack
 * unless the user named a pack directory (an empty value counts as unset, as it does for the
 * binary itself).
 */
function childEnv(env: NodeJS.ProcessEnv, packDir: string): NodeJS.ProcessEnv {
  const named = env[PACK_DIR_ENV]

  return {
    ...env,
    [SHIM_GUARD_ENV]: '1',
    [PACK_DIR_ENV]: named === undefined || named.length === 0 ? packDir : named,
  }
}

/**
 * Resolve the native binary and run it. Returns the child exit code, or `2` when
 * the binary cannot be found or this shim was started by a shim. Injected `exec`
 * supports tests without spawning.
 */
export function main(argv: string[], options: TExecKizunaSyncBinaryOptions = {}): number {
  const env = options.env ?? process.env

  if (env[SHIM_GUARD_ENV] === '1') {
    process.stderr.write(`${RECURSION_MESSAGE}\n`)

    return 2
  }

  const shimEntry = options.shimEntry ?? defaultShimEntry()
  const binary =
    resolveKizunaSyncBinary({
      env,
      shimEntry,
    }) ?? undefined

  if (binary === undefined) {
    process.stderr.write(`${kizunasyncBinaryMissingMessage()}\n`)

    return 2
  }

  const exec = options.exec ?? spawnKizunaSyncBinary
  const result = exec(binary, argv, {
    stdio: 'inherit',
    env: childEnv(env, options.packDir ?? shippedPackDir()),
    cwd: options.cwd ?? process.cwd(),
  })

  return execResultToExitCode(result, binary)
}

/**
 * `process.argv[1]` is whatever path this process was invoked with (a symlink,
 * such as npm's `node_modules/.bin/kizunasync`, or the file directly); `import.meta.url`
 * is Node's realpath of the module it loaded. Comparing them without
 * `realpathSync` on both sides fails for any symlinked invocation, and the CLI
 * silently no-ops instead of running.
 */
function isMainModule(): boolean {
  const entry = process.argv[1]

  if (!entry) {
    return false
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry))
  } catch {
    return false
  }
}

if (isMainModule()) {
  process.exit(main(process.argv.slice(2)))
}
