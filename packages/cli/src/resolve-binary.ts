/**
 * Resolve the native `kizunasync` binary for the Node shim.
 *
 * Order: `KSYNC_BIN` → installed `@kizunasync/cli-<triple>` platform package →
 * `target/release|debug/kizunasync` of the workspace this shim itself sits in (never one
 * found from the working directory) → PATH `kizunasync`, skipping every entry whose real
 * path is this Node entrypoint, so a symlinked `.bin/kizunasync` cannot start the shim again.
 */

import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BUILD_HINT =
  'Reinstall kizunasync so its platform package (an optional dependency) installs:\n\n  npm install kizunasync\n\n' +
  'Or build the Rust CLI from source:\n\n  cargo build -p kizunasync-cli\n\n' +
  'Or point at a built binary:\n\n  export KSYNC_BIN=/path/to/kizunasync'

export type TResolveKizunaSyncBinaryOptions = {
  env?: NodeJS.ProcessEnv

  /** Absolute path to this shim entry (dist/main.js or src/main.ts). */
  shimEntry?: string

  /** Test-only: resolve `@kizunasync/cli-<triple>` relative to this directory instead of this module's own location. */
  platformPackageRoot?: string
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)

    return true
  } catch {
    return false
  }
}

function binaryName(): string {
  return process.platform === 'win32' ? 'kizunasync.exe' : 'kizunasync'
}

/**
 * `<platform>-<arch>` npm target triple. Mirrors the same mapping in
 * `packages/core/src/query/napi-loader.ts` and `scripts/prepare-npm-release.ts`;
 * `null` for any combination with no published platform package.
 */
export function platformTriple(platform: string, arch: string): string | null {
  if (arch !== 'arm64' && arch !== 'x64') {
    return null
  }
  if (platform === 'darwin') {
    return `darwin-${arch}`
  }
  if (platform === 'linux') {
    return `linux-${arch}-gnu`
  }
  if (platform === 'win32' && arch === 'x64') {
    return 'win32-x64-msvc'
  }
  return null
}

/** The installed `@kizunasync/cli-<triple>` optional dependency's binary path, or undefined. */
function platformPackageBinary(platformPackageRoot: string | undefined): string | undefined {
  const triple = platformTriple(process.platform, process.arch)

  if (triple === null) {
    return undefined
  }
  try {
    const baseUrl =
      platformPackageRoot === undefined
        ? import.meta.url
        : pathToFileURL(join(resolve(platformPackageRoot), 'index.js')).href
    const packageJsonPath = createRequire(baseUrl).resolve(`@kizunasync/cli-${triple}/package.json`)
    const bin = join(dirname(packageJsonPath), 'bin', binaryName())

    return isExecutable(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

/** True when `dir/Cargo.toml` exists and its text carries the `crates/kizunasync-cli` marker. */
function dirHasKizunaSyncCliCargoToml(dir: string): boolean {
  const cargoToml = join(dir, 'Cargo.toml')

  if (!existsSync(cargoToml)) {
    return false
  }
  try {
    return readFileSync(cargoToml, 'utf8').includes('crates/kizunasync-cli')
  } catch {
    // An unreadable Cargo.toml cannot carry the crates/kizunasync-cli marker; keep walking up.
    return false
  }
}

/**
 * `KIZUNASYNC_REPO_ROOT` when set, else the nearest ancestor of this shim whose `Cargo.toml`
 * names `crates/kizunasync-cli`. The working directory is never searched: an app project the
 * package is installed into must not answer for the CLI with a `target/` of its own.
 */
function repoRoot(env: NodeJS.ProcessEnv, shimEntry: string | undefined): string | undefined {
  const override = env.KIZUNASYNC_REPO_ROOT

  if (override !== undefined && override.length > 0) {
    return resolve(override)
  }

  if (shimEntry === undefined) {
    return undefined
  }

  let dir = dirname(resolve(shimEntry))

  for (;;) {
    if (dirHasKizunaSyncCliCargoToml(dir)) {
      return dir
    }
    const parent = dirname(dir)

    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

function workspaceCandidates(env: NodeJS.ProcessEnv, shimEntry: string | undefined): string[] {
  const root = repoRoot(env, shimEntry)

  if (root === undefined) {
    return []
  }

  const name = binaryName()

  return [join(root, 'target', 'release', name), join(root, 'target', 'debug', name)]
}

/** The real path of `path`, or undefined when it does not resolve. */
function realpathOf(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function pathCandidates(env: NodeJS.ProcessEnv, shimEntry: string | undefined): string[] {
  const pathEnv = env.PATH ?? env.Path

  if (pathEnv === undefined || pathEnv.length === 0) {
    return []
  }

  const sep = process.platform === 'win32' ? ';' : ':'
  const name = binaryName()
  const shimReal = shimEntry === undefined ? undefined : realpathOf(shimEntry)

  return pathEnv
    .split(sep)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (isAbsolute(entry) ? join(entry, name) : resolve(entry, name)))
    .filter((candidate) => {
      if (!existsSync(candidate)) {
        return false
      }

      return shimReal === undefined || realpathOf(candidate) !== shimReal
    })
}

/**
 * `KSYNC_BIN` gates the whole search: once set (non-empty), it is
 * authoritative, so `isSet` tells the caller whether to return `binary`
 * as-is instead of falling through to the platform package/workspace/PATH lookups.
 */
function resolveExplicitOverride(env: NodeJS.ProcessEnv): { isSet: boolean; binary: string | undefined } {
  const explicit = env.KSYNC_BIN

  if (explicit === undefined || explicit.length === 0) {
    return { isSet: false, binary: undefined }
  }
  const resolved = resolve(explicit)

  return { isSet: true, binary: isExecutable(resolved) ? resolved : undefined }
}

function findExecutableCandidate(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  return undefined
}

/** Returns an executable path, or `undefined` when nothing resolves. */
export function resolveKizunaSyncBinary(options: TResolveKizunaSyncBinaryOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const shimEntry = options.shimEntry

  const override = resolveExplicitOverride(env)

  if (override.isSet) {
    return override.binary
  }

  const platformBinary = platformPackageBinary(options.platformPackageRoot)

  if (platformBinary !== undefined) {
    return platformBinary
  }

  return findExecutableCandidate(workspaceCandidates(env, shimEntry)) ?? findExecutableCandidate(pathCandidates(env, shimEntry))
}

export function kizunasyncBinaryMissingMessage(): string {
  return `kizunasync: native CLI binary not found.\n\n${BUILD_HINT}`
}

export function defaultShimEntry(): string {
  const self = fileURLToPath(import.meta.url)

  if (/resolve-binary\.(ts|js)$/.test(self)) {
    return self.replace(/resolve-binary\.(ts|js)$/, 'main.$1')
  }
  // Bundled dist/main.js: this module shares import.meta.url with the entry.
  return self
}
