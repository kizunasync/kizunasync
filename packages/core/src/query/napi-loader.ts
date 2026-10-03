// MARK: - Native addon loader

/**
 * Engine selection for `createKizunaSync` is handled in this module, which is also
 * used by web and React Native bundles. This code imports nothing from Node core
 * (`fs`, `module`, `path`): every native interaction goes through `globalThis`,
 * guarded at runtime, so bundlers never see a `node:` import to shim.
 *
 * Loading tries `dlopen` and catches the error rather than checking file
 * existence first: a missing addon, a wrong architecture, and a mismatched ABI
 * all land on the same "can we load this here" question.
 *
 * For building native code (from the monorepo root):
 *   bun run cargo:napi              # debug build, outputs to target/debug/
 *   bun run cargo:napi:prebuild     # release build, copies to packages/core/src/native/
 *
 * At runtime, addon candidates are tried in this order:
 * 1. The `@kizunasync/napi-<triple>` optional dependency, which is what apps typically
 *    have installed (resolved using `require.resolve` if available).
 * 2. Any staged prebuild in the source tree.
 * 3. Native builds in the Cargo target directories of the repository this
 *    package sits in, never the working directory's, so an old debug build
 *    never overrides an intended prebuild.
 *
 * Prebuilds are laid out as:
 *   packages/core/src/native/<platform>-<arch>/libkizunasync_napi.{dylib,so,dll}
 *
 * To override and load a specific native library, set:
 *   KSYNC_NAPI_PATH=/absolute/path/to/lib
 */

import type { IEngineTransport } from '../ports/engine-transport'

/**
 * One engine instance: its own database, remote and event stream. `IEngineTransport`
 * is the contract, owned by the port, and every backend answers through a factory
 * that returns one: the addon constructor below, or the transport a driver carries.
 * This interface is the addon's own view of that contract, so only its `call`
 * widens, and it widens because `createRustEngine` awaits the answer either way.
 */
export interface INapiEngine extends Omit<IEngineTransport, 'call'> {
  /** Run one engine method; resolves the JSON response envelope. */
  call(method: string, paramsJson: string): Promise<string> | string
}

type TNapiEngineConstructor = new (
  configJson: string,
  databasePath: string | null,
  pull: (requestJson: string) => Promise<string>,
  push: (requestJson: string) => Promise<string>,
  onEvent: (eventJson: string) => void,
) => INapiEngine

export interface INapiAddon {
  ping(): string
  KizunaSyncEngine: TNapiEngineConstructor
}

type TNodeProcess = {
  dlopen?: (module: { exports: unknown }, path: string) => void
  platform?: string
  arch?: string
  env?: Record<string, string | undefined>
  getBuiltinModule?: (id: string) => unknown
}

const nodeProcess = (): TNodeProcess | null => {
  const candidate = (globalThis as { process?: TNodeProcess }).process

  if (candidate === undefined || typeof candidate.dlopen !== 'function') {
    return null
  }
  return candidate
}

const libraryFileName = (platform: string): string => {
  if (platform === 'darwin') {
    return 'libkizunasync_napi.dylib'
  }
  if (platform === 'win32') {
    return 'kizunasync_napi.dll'
  }
  return 'libkizunasync_napi.so'
}

/**
 * Directory of this module, derived from the ESM URL (no `node:path`, so no
 * `fileURLToPath`). A raw `URL.pathname` is percent-encoded and, on Windows,
 * carries a leading slash before the drive letter (`/C:/...`) that `dlopen`
 * rejects: both are undone here.
 */
const moduleDirectory = (): string => {
  try {
    const url = new URL('.', import.meta.url)

    if (url.protocol !== 'file:') {
      return ''
    }
    const path = decodeURIComponent(url.pathname)

    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
  } catch {
    return ''
  }
}

const join = (...parts: string[]): string =>
  parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/')

/** Everything up to (excluding) the final path separator. No `node:path`, so `dirname` by hand. */
const parentDirectory = (path: string): string => {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return index === -1 ? path : path.slice(0, index)
}

/**
 * The platform package and the library file it ships, or `null` for a
 * combination without one. Mirrors `PLATFORM_TARGETS` in
 * `scripts/prepare-npm-release.ts`, which is the single source of truth;
 * `napi-prebuild.test.ts` reads that table and fails when the two disagree.
 */
export interface INapiHost {
  platform: string
  arch: string
}

export function napiPlatformArtifact({
  platform,
  arch,
}: INapiHost): { package: string; library: string } | null {
  if (arch !== 'arm64' && arch !== 'x64') {
    return null
  }
  const library = libraryFileName(platform)

  if (platform === 'darwin') {
    return { package: `@kizunasync/napi-darwin-${arch}`, library }
  }
  if (platform === 'linux') {
    return { package: `@kizunasync/napi-linux-${arch}-gnu`, library }
  }
  if (platform === 'win32' && arch === 'x64') {
    return { package: '@kizunasync/napi-win32-x64-msvc', library }
  }
  return null
}

/**
 * The package this runtime would install the addon from, or `null` where none
 * is published (and on a runtime with no `process`, which loads no addon).
 */
export function napiPlatformPackage(): string | null {
  const runtime = nodeProcess()

  if (runtime === null) {
    return null
  }
  return (
    napiPlatformArtifact({ platform: runtime.platform ?? 'linux', arch: runtime.arch ?? 'x64' })
      ?.package ?? null
  )
}

type TNodeModuleBuiltin = {
  createRequire?: (url: string) => { resolve: (id: string) => string }
}

/** The installed `@kizunasync/napi-<triple>` optional dependency's library path, or null. */
function platformPackageCandidate(runtime: TNodeProcess, host: INapiHost): string | null {
  const artifact = napiPlatformArtifact(host)

  if (artifact === null) {
    return null
  }
  try {
    const moduleBuiltin = runtime.getBuiltinModule?.('module') as TNodeModuleBuiltin | undefined
    const createRequire = moduleBuiltin?.createRequire

    if (createRequire === undefined) {
      return null
    }
    const packageJsonPath = createRequire(import.meta.url).resolve(`${artifact.package}/package.json`)

    return join(parentDirectory(packageJsonPath), artifact.library)
  } catch {
    return null
  }
}

/** What the caller forced: the explicit path first, then `KSYNC_NAPI_PATH`. */
function forcedCandidates(runtime: TNodeProcess, explicit: string | undefined): string[] {
  const candidates: string[] = []

  if (explicit !== undefined && explicit !== '') {
    candidates.push(explicit)
  }
  const fromEnv = runtime.env?.KSYNC_NAPI_PATH

  if (fromEnv !== undefined && fromEnv !== '') {
    candidates.push(fromEnv)
  }
  return candidates
}

/** Where this checkout stages or builds the addon. */
type TCheckoutLayout = {
  platform: string
  arch: string
  name: string
  here: string
}

/**
 * What this checkout staged or built: the prebuild directory, then the Cargo
 * target directories of the repository this package sits in. Both are found
 * from this module's own location, never the working directory, so a process
 * started elsewhere cannot load a library that happens to sit under its cwd.
 */
function checkoutCandidates(layout: TCheckoutLayout): string[] {
  const { platform, arch, name, here } = layout
  const repositoryRoot = join(here, '../../../..')

  return [
    join(here, '../native', `${platform}-${arch}`, name),
    join(repositoryRoot, 'target/debug', name),
    join(repositoryRoot, 'target/release', name),
  ]
}

/**
 * Every place a built or staged addon may live, in resolution order: what the
 * caller forced, then what the app installed, then what this checkout built.
 */
export const napiCandidatePaths = (explicit?: string): string[] => {
  const runtime = nodeProcess()

  if (runtime === null) {
    return []
  }
  const platform = runtime.platform ?? 'linux'
  const arch = runtime.arch ?? 'x64'
  const layout: TCheckoutLayout = {
    platform,
    arch,
    name: libraryFileName(platform),
    here: moduleDirectory(),
  }
  const candidates = forcedCandidates(runtime, explicit)
  const platformPackage = platformPackageCandidate(runtime, { platform, arch })

  if (platformPackage !== null) {
    candidates.push(platformPackage)
  }
  return [...candidates, ...checkoutCandidates(layout)]
}

const isAddon = (value: unknown): value is INapiAddon =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { ping?: unknown }).ping === 'function' &&
  typeof (value as { KizunaSyncEngine?: unknown }).KizunaSyncEngine === 'function'

/** One candidate path the loader could not use, and why. */
export interface INapiLoadFailure {
  path: string
  reason: string
}

const NOT_AN_ADDON = 'loaded without the kizunasync-napi surface (a stale or foreign build)'

/**
 * `dlopen` registers the addon process-wide; opening the same library twice is
 * wasted work at best. The first successful load is shared by every caller.
 * `null` is cached too: the answer cannot change within a process.
 */
let cached: INapiAddon | null | undefined

/** Why each candidate of the cached probe was passed over, in the order they were tried. */
let cachedFailures: readonly INapiLoadFailure[] = []

/** Test hook: forget a previous probe so the next `loadNapiAddon()` searches again. */
export const resetNapiAddonCache = (): void => {
  cached = undefined
  cachedFailures = []
}

/**
 * Why the cached probe passed over each candidate it tried. After a probe that
 * found no addon this names every candidate, which is what `ENGINE_UNAVAILABLE`
 * lists; it is empty before any probe and on a runtime that cannot load one.
 */
export const napiLoadFailures = (): readonly INapiLoadFailure[] => cachedFailures

export const loadNapiAddon = (explicit?: string): INapiAddon | null => {
  if (explicit === undefined && cached !== undefined) {
    return cached
  }
  const runtime = nodeProcess()
  const dlopen = runtime?.dlopen

  if (runtime === null || dlopen === undefined) {
    cached = null
    cachedFailures = []

    return null
  }
  const failures: INapiLoadFailure[] = []
  let addon: INapiAddon | null = null

  for (const path of napiCandidatePaths(explicit)) {
    const opened = openCandidate({ runtime, dlopen, path })

    if (typeof opened !== 'string') {
      addon = opened
      break
    }
    failures.push({ path, reason: opened })
  }
  if (explicit === undefined) {
    cached = addon
    cachedFailures = failures
  }
  return addon
}

/** The addon one candidate path holds, or why it holds none. */
function openCandidate(candidate: {
  runtime: TNodeProcess
  dlopen: NonNullable<TNodeProcess['dlopen']>
  path: string
}): INapiAddon | string {
  const { runtime, dlopen, path } = candidate
  const container: { exports: unknown } = { exports: {} }

  try {
    dlopen.call(runtime, container, path)
  } catch (error) {
    // Missing, foreign-arch or ABI-stale: the runtime's own message says which.
    return error instanceof Error ? error.message : String(error)
  }
  // A library that loads but lacks the surface is a stale prebuild. Reject it; do not expose half an engine.
  return isAddon(container.exports) ? container.exports : NOT_AN_ADDON
}
