/**
 * prepare-npm-release: assemble the npm distribution into `<out>/`, ready for
 * `npm publish` in `publish-order.txt` order. `kizunasync` is built from the
 * private workspaces: each one is packed with `npm pack`, placed by
 * PUBLISHED_LAYOUT (the single owner of the published layout), and every
 * private specifier in the staged code becomes a relative path. One
 * `@kizunasync/<triple>` package per platform carries the CLI binary and the
 * N-API library. Run from the repository root:
 *
 *   bun scripts/prepare-npm-release.ts <version> [--binaries <dir>] [--out dist/npm] [--smoke]
 *
 * `--binaries <dir>` must contain `<dir>/<triple>/<N-API library file>` and
 * `<dir>/<triple>/<CLI binary file>` for every triple in PLATFORM_TARGETS;
 * without it, only `kizunasync` is staged. The workspace builds and
 * `bun run cargo:wasm` must have run first. `--smoke` installs the staged
 * output into `<out>/smoke/node_modules` and imports/execs it.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

// MARK: - Platform table

type TPlatform = 'darwin' | 'linux' | 'win32'
type TArch = 'arm64' | 'x64'

interface IPlatformTarget {
  triple: string
  platform: TPlatform
  arch: TArch
  napiLibrary: string
  cliBinary: string
}

const PLATFORM_TARGETS: IPlatformTarget[] = [
  {
    triple: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    napiLibrary: 'libkizunasync_napi.dylib',
    cliBinary: 'kizunasync',
  },
  {
    triple: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    napiLibrary: 'libkizunasync_napi.dylib',
    cliBinary: 'kizunasync',
  },
  {
    triple: 'linux-x64-gnu',
    platform: 'linux',
    arch: 'x64',
    napiLibrary: 'libkizunasync_napi.so',
    cliBinary: 'kizunasync',
  },
  {
    triple: 'linux-arm64-gnu',
    platform: 'linux',
    arch: 'arm64',
    napiLibrary: 'libkizunasync_napi.so',
    cliBinary: 'kizunasync',
  },
  {
    triple: 'win32-x64-msvc',
    platform: 'win32',
    arch: 'x64',
    napiLibrary: 'kizunasync_napi.dll',
    cliBinary: 'kizunasync.exe',
  },
]

// MARK: - Published layout

/** One path of a workspace's packed tarball and where the staged `kizunasync` carries it. */
export interface IStagedPlacement {
  from: string
  to: string
}

export interface IWorkspaceLayout {
  name: string
  dir: string

  /** The workspace publishes its esbuild output: a `./src/X.ts` export ships as `dist/X.js`. */
  isBuilt: boolean

  placements: IStagedPlacement[]
}

const PUBLIC_PACKAGE_NAME = 'kizunasync'

const PUBLIC_PACKAGE_DIR = 'packages/kizunasync'

const RN_UNIFFI_PACKAGE_NAME = '@kizunasync/rn-uniffi'

/** The private workspaces `kizunasync` is assembled from; their specifiers never reach the published code. */
export const PRIVATE_LAYOUT: IWorkspaceLayout[] = [
  { name: '@kizunasync/core', dir: 'packages/core', isBuilt: true, placements: [{ from: 'dist', to: 'dist/core' }] },
  { name: '@kizunasync/supabase', dir: 'packages/supabase', isBuilt: true, placements: [{ from: 'dist', to: 'dist/supabase' }] },
  { name: '@kizunasync/react', dir: 'packages/react', isBuilt: true, placements: [{ from: 'dist', to: 'dist/react' }] },
  { name: '@kizunasync/vue', dir: 'packages/vue', isBuilt: true, placements: [{ from: 'dist', to: 'dist/vue' }] },
  { name: '@kizunasync/web', dir: 'packages/web', isBuilt: false, placements: [{ from: 'src', to: 'dist/web' }] },
  { name: '@kizunasync/expo', dir: 'packages/expo', isBuilt: false, placements: [{ from: 'src', to: 'dist/expo' }] },
  { name: RN_UNIFFI_PACKAGE_NAME, dir: 'packages/rn-uniffi', isBuilt: false, placements: ['src', 'ios', 'android', 'RnUniffi.podspec', 'ubrn.config.yaml'].map(unmoved) },
]

/** Everything the staged `kizunasync` holds besides LICENSE and its composed `package.json`. */
export const PUBLISHED_LAYOUT: IWorkspaceLayout[] = [
  ...PRIVATE_LAYOUT,
  { name: PUBLIC_PACKAGE_NAME, dir: PUBLIC_PACKAGE_DIR, isBuilt: false, placements: ['dist', 'pack', 'README.md'].map(unmoved) },
]

const BUILD_OUT_DIR = 'dist'

const SOURCE_EXPORT = /^\.\/src\/(.+)\.ts$/

/**
 * What a usable web driver carries. The two `.d.ts` files are tracked, but
 * `kizunasync_wasm.js` and `kizunasync_wasm_bg.wasm` are git-ignored wasm-bindgen output,
 * so a staging run on a tree where `bun run cargo:wasm` never ran produces a
 * package whose worker cannot instantiate the engine, and npm would take it.
 */
const WEB_WASM_ASSETS = [
  'src/wasm/kizunasync_wasm.js',
  'src/wasm/kizunasync_wasm_bg.wasm',
  'src/wasm/kizunasync_wasm.d.ts',
  'src/wasm/kizunasync_wasm_bg.wasm.d.ts',
]

const WEB_PACKAGE_NAME = '@kizunasync/web'

/** What the React Native module needs to autolink and compile from the installed package. */
const RN_MODULE_FILES = ['RnUniffi.podspec', 'ios/RnUniffi.mm', 'android/build.gradle', 'src/generated/NativeRnUniffi.ts']

/** ubrn's generated C++ bindings, git-ignored, which the podspec and CMake compile. */
const RN_GENERATED_CPP_DIR = 'src/generated/cpp'

/** The SQL pack the `kizunasync` build copies into its `pack/`; the source of truth the staged copy must match. */
const SUPABASE_PACK_DIR = 'packages/supabase-pack'

const PACK_MANIFEST_FILE = 'pack.manifest.json'

const PACK_MIGRATIONS_DIR = 'supabase/migrations'

const PACKED_PACK_DIR = 'pack'

const LICENSE_FILE = 'LICENSE'

const PACKAGE_JSON_FILE = 'package.json'

function unmoved(path: string): IStagedPlacement {
  return { from: path, to: path }
}

/** Where the staged `kizunasync` carries `packedPath` of `layout`'s tarball, or undefined when no placement takes it. */
function stagedPathOf(layout: IWorkspaceLayout, packedPath: string): string | undefined {
  for (const { from, to } of layout.placements) {
    if (packedPath === from || packedPath.startsWith(`${from}/`)) {
      return posix.join(to, packedPath.slice(from.length))
    }
  }
  return undefined
}

/** The path inside the packed tarball of the file a dev `exports` target names. */
export function packedPathOfExport(layout: IWorkspaceLayout, target: string): string {
  const builtName = layout.isBuilt ? SOURCE_EXPORT.exec(target)?.[1] : undefined

  return builtName === undefined ? posix.normalize(target) : `${BUILD_OUT_DIR}/${builtName}.js`
}

function layoutOf(name: string): IWorkspaceLayout {
  const layout = PUBLISHED_LAYOUT.find((candidate) => candidate.name === name)

  if (layout === undefined) {
    throw new Error(`${name} is not in PUBLISHED_LAYOUT`)
  }
  return layout
}

// MARK: - CLI args

interface ICliArgs {
  version: string
  binariesDir?: string
  outDir: string
  smoke: boolean
}

function usageAndExit(message?: string): never {
  if (message !== undefined) {
    console.error(message)
  }
  console.error('usage: bun scripts/prepare-npm-release.ts <version> [--binaries <dir>] [--out dist/npm] [--smoke]')
  process.exit(2)
}

function parseArgs(argv: string[]): ICliArgs {
  const version = argv[0]

  if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    usageAndExit(`invalid or missing <version>: ${version ?? '(none)'}`)
  }

  let binariesDir: string | undefined
  let outDir = 'dist/npm'
  let smoke = false

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--binaries') {
      i += 1
      const value = argv[i]

      if (value === undefined) {
        usageAndExit('--binaries requires a directory argument')
      }
      binariesDir = value
    } else if (arg === '--out') {
      i += 1
      const value = argv[i]

      if (value === undefined) {
        usageAndExit('--out requires a directory argument')
      }
      outDir = value
    } else if (arg === '--smoke') {
      smoke = true
    } else {
      usageAndExit(`unknown argument: ${arg}`)
    }
  }

  return { version, binariesDir, outDir, smoke }
}

// MARK: - Package manifests

type TDependencyMap = Record<string, string>

type TExportTarget = string | Record<string, string>

export interface IPackageJson {
  name: string
  version: string
  bin?: Record<string, string>
  exports?: Record<string, TExportTarget>
  engines?: Record<string, string>
  dependencies?: TDependencyMap
  peerDependencies?: TDependencyMap
  codegenConfig?: unknown
  publishConfig?: {
    access?: string
    exports?: Record<string, TExportTarget>
    optionalDependencies?: TDependencyMap
  }
  [key: string]: unknown
}

const WORKSPACE_RANGE = /^workspace:[*^~]?$/

const PUBLISHED_DESCRIPTION = 'Offline-first sync for Supabase: the kizunasync CLI and the JavaScript, React, Vue, web, and Expo app clients.'

const REPOSITORY_URL = 'https://github.com/kizunasync/kizunasync.git'

function readWorkspacePackageJson(dir: string): IPackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, PACKAGE_JSON_FILE), 'utf8')) as IPackageJson
}

/** Every string an `exports` map points at, conditions included. */
export function exportTargets(exports: Record<string, TExportTarget>): string[] {
  return Object.values(exports).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target)))
}

function sortedByName(map: TDependencyMap): TDependencyMap {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
}

/** One map of every non-workspace range the packages declare under `field`; two different ranges for one name stop the run. */
export function unionDependencies(packages: IPackageJson[], field: 'dependencies' | 'peerDependencies'): TDependencyMap {
  const union: TDependencyMap = {}
  const declaredBy: Record<string, string> = {}

  for (const pkg of packages) {
    for (const [name, range] of Object.entries(pkg[field] ?? {}).filter(([, candidate]) => !WORKSPACE_RANGE.test(candidate))) {
      const existing = union[name]

      if (existing !== undefined && existing !== range) {
        throw new Error(`${field} conflict for ${name}: ${declaredBy[name]} declares ${existing}, ${pkg.name} declares ${range}`)
      }
      union[name] = range
      declaredBy[name] = pkg.name
    }
  }
  return sortedByName(union)
}

export interface IComposeOptions {
  version: string
  publicPackage: IPackageJson
  privatePackages: IPackageJson[]
  files: string[]
}

/** The published `kizunasync` manifest: its own CLI fields plus what the private workspaces need at runtime. */
export function composePublishedPackageJson(options: IComposeOptions): IPackageJson {
  const { version, publicPackage, privatePackages, files } = options
  const exports = publicPackage.publishConfig?.exports
  const codegenConfig = privatePackages.find((pkg) => pkg.name === RN_UNIFFI_PACKAGE_NAME)?.codegenConfig

  if (exports === undefined || codegenConfig === undefined) {
    throw new Error(`the published manifest needs ${PUBLIC_PACKAGE_DIR} publishConfig.exports and the ${RN_UNIFFI_PACKAGE_NAME} codegenConfig`)
  }

  const peerDependencies = unionDependencies(privatePackages, 'peerDependencies')
  const platformPackages = Object.keys(publicPackage.publishConfig?.optionalDependencies ?? {})

  return {
    name: PUBLIC_PACKAGE_NAME,
    version,
    description: PUBLISHED_DESCRIPTION,
    license: 'Apache-2.0',
    author: 'Kizuna Sync',
    homepage: 'https://kizunasync.com',
    repository: { type: 'git', url: REPOSITORY_URL, directory: PUBLIC_PACKAGE_DIR },
    type: 'module',
    bin: publicPackage.bin,
    exports,
    files,
    engines: publicPackage.engines,
    dependencies: unionDependencies(privatePackages, 'dependencies'),
    peerDependencies,
    peerDependenciesMeta: Object.fromEntries(Object.keys(peerDependencies).map((name) => [name, { optional: true }])),
    optionalDependencies: Object.fromEntries(platformPackages.map((name) => [name, version])),
    codegenConfig,
    publishConfig: { access: 'public' },
  }
}

// MARK: - Specifier rewrite

/**
 * A single- or double-quoted literal that is exactly a private workspace
 * specifier, with or without a subpath. Backticks in shipped doc comments
 * quote package names as prose, and a literal with a space is a message, not
 * a specifier.
 */
const PRIVATE_SPECIFIER_PATTERN = `(['"])(@kizunasync/(?:${PRIVATE_LAYOUT.map(({ name }) => name.slice('@kizunasync/'.length)).join('|')})(?:/[^'"\\s]+)?)\\1`

const QUOTED_PRIVATE_SPECIFIER = new RegExp(PRIVATE_SPECIFIER_PATTERN, 'g')

const RESIDUAL_PRIVATE_SPECIFIER = new RegExp(PRIVATE_SPECIFIER_PATTERN)

export interface IWorkspaceExports {
  layout: IWorkspaceLayout
  exports: Record<string, TExportTarget>
}

/** Every private specifier (`@kizunasync/core/config`) and the staged path its import has to reach. */
export function privateSpecifierTargets(workspaces: IWorkspaceExports[]): Map<string, string> {
  const targets = new Map<string, string>()

  for (const { layout, exports } of workspaces) {
    for (const [key, target] of Object.entries(exports)) {
      const specifier = key === '.' ? layout.name : `${layout.name}/${key.slice('./'.length)}`

      if (typeof target !== 'string') {
        throw new Error(`${specifier}: a private workspace export is one path, not a condition map`)
      }
      const packedPath = packedPathOfExport(layout, target)
      const stagedPath = stagedPathOf(layout, packedPath)

      if (stagedPath === undefined) {
        throw new Error(`${specifier} resolves to ${packedPath}, which no placement of ${layout.name} stages`)
      }
      targets.set(specifier, stagedPath)
    }
  }
  return targets
}

function isCompiledFile(file: string): boolean {
  return file.endsWith('.js') || file.endsWith('.d.ts')
}

function isTypeScriptSource(file: string): boolean {
  return file.endsWith('.ts') && !file.endsWith('.d.ts')
}

/** Files whose import specifiers the rewrite owns. */
function isRewrittenFile(file: string): boolean {
  return isCompiledFile(file) || isTypeScriptSource(file)
}

interface IRelativeSpecifierOptions {
  file: string
  specifier: string
  target: string
}

/**
 * The relative specifier that reaches staged `target` from staged `file`.
 * TypeScript source imports TypeScript source without an extension; every
 * other target keeps its file name. Compiled output cannot import TypeScript
 * source, so that pairing stops the run.
 */
function relativeSpecifier({ file, specifier, target }: IRelativeSpecifierOptions): string {
  const path = posix.relative(posix.dirname(file), target)
  const relativePath = path.startsWith('../') ? path : `./${path}`

  if (!isTypeScriptSource(target)) {
    return relativePath
  }
  if (!isTypeScriptSource(file)) {
    throw new Error(`${file} imports ${specifier}, whose staged target ${target} is TypeScript source that compiled output cannot load`)
  }
  return relativePath.slice(0, -'.ts'.length)
}

export interface IRewriteOptions {
  file: string
  text: string
  targets: ReadonlyMap<string, string>
}

/** `text` of staged `file` with every quoted private specifier replaced by the relative path to its staged target. */
export function rewritePrivateSpecifiers({ file, text, targets }: IRewriteOptions): string {
  return text.replace(QUOTED_PRIVATE_SPECIFIER, (literal: string, quote: string, specifier: string) => {
    const target = targets.get(specifier)

    if (target === undefined) {
      return literal
    }
    return `${quote}${relativeSpecifier({ file, specifier, target })}${quote}`
  })
}

/** Every file under `root`, as a `/`-separated path relative to it. */
function listStagedFiles(root: string): string[] {
  const files: string[] = []

  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      files.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    }
  }
  return files.sort()
}

/** Rewrites every private specifier under `stagedRoot` in place. */
export function rewriteStagedSpecifiers(stagedRoot: string, targets: ReadonlyMap<string, string>): void {
  for (const file of listStagedFiles(stagedRoot).filter(isRewrittenFile)) {
    const path = join(stagedRoot, file)
    const text = readFileSync(path, 'utf8')
    const rewritten = rewritePrivateSpecifiers({ file, text, targets })

    if (rewritten !== text) {
      writeFileSync(path, rewritten)
    }
  }
}

/**
 * Staged code files that still carry a quoted private specifier after the
 * rewrite. Source maps stay as built: nothing executes them, and their
 * `sourcesContent` is debugging data.
 */
export function findResidualPrivateSpecifiers(stagedRoot: string): string[] {
  return listStagedFiles(stagedRoot)
    .filter(isRewrittenFile)
    .filter((file) => RESIDUAL_PRIVATE_SPECIFIER.test(readFileSync(join(stagedRoot, file), 'utf8')))
}

export function assertNoResidualPrivateSpecifiers(stagedRoot: string): void {
  const residual = findResidualPrivateSpecifiers(stagedRoot)

  if (residual.length > 0) {
    throw new Error(`staged kizunasync still names a private workspace in:\n${residual.map((file) => `  ${file}`).join('\n')}`)
  }
}

// MARK: - kizunasync staging

/** `npm pack`s the workspace at `dir` into `tmpDir` and returns the extracted `package/` directory. */
function packWorkspace(dir: string, tmpDir: string): string {
  const packOutput = execFileSync('npm', ['pack', '--pack-destination', tmpDir, '--ignore-scripts', '--json'], {
    cwd: join(REPO_ROOT, dir),
    encoding: 'utf8',
  })
  const [packed] = JSON.parse(packOutput) as Array<{ filename: string }>

  if (packed === undefined) {
    throw new Error(`npm pack produced no tarball for ${dir}`)
  }

  const extractDir = mkdtempSync(join(tmpDir, 'extract-'))

  execFileSync('tar', ['-xzf', join(tmpDir, packed.filename), '-C', extractDir])

  return join(extractDir, 'package')
}

/** The files copying `source` onto `destination` would overwrite. */
function placementCollisions(source: string, destination: string): string[] {
  const files = statSync(source).isDirectory() ? listStagedFiles(source).map((file) => join(destination, file)) : [destination]

  return files.filter((file) => existsSync(file))
}

/** Copies what `layout` places from the extracted tarball at `packedDir` into `stagedRoot`; anything else in the tarball is dropped. */
export function placeWorkspace(layout: IWorkspaceLayout, packedDir: string, stagedRoot: string): void {
  for (const { from, to } of layout.placements) {
    const source = join(packedDir, from)

    if (!existsSync(source)) {
      throw new Error(`${layout.name} packed no ${from}`)
    }
    const collisions = placementCollisions(source, join(stagedRoot, to))

    if (collisions.length > 0) {
      throw new Error(`${layout.name} ${from} would overwrite staged files:\n${collisions.map((file) => `  ${file}`).join('\n')}`)
    }
    cpSync(source, join(stagedRoot, to), { recursive: true })
  }
}

function copyRootLicense(packageDir: string): void {
  cpSync(join(REPO_ROOT, LICENSE_FILE), join(packageDir, LICENSE_FILE))
}

function stagedTopLevelFiles(stagedRoot: string): string[] {
  return readdirSync(stagedRoot)
    .filter((entry) => entry !== PACKAGE_JSON_FILE)
    .sort()
}

/** The staged paths of `packedPaths` from workspace `name` that the staged tree lacks. */
function missingStagedFiles(stagedRoot: string, name: string, packedPaths: string[]): string[] {
  const layout = layoutOf(name)

  return packedPaths.map((packedPath) => stagedPathOf(layout, packedPath) ?? packedPath).filter((path) => !existsSync(join(stagedRoot, path)))
}

function validateStagedWebAssets(stagedRoot: string): void {
  const missing = missingStagedFiles(stagedRoot, WEB_PACKAGE_NAME, WEB_WASM_ASSETS)

  if (missing.length > 0) {
    throw new Error(`staged kizunasync is missing the web driver's wasm glue (run \`bun run cargo:wasm\` first):\n${missing.map((path) => `  ${path}`).join('\n')}`)
  }
}

/** Fails the run when the staged React Native module lacks its native sources or ubrn's generated bindings. */
export function validateStagedReactNativeModule(stagedRoot: string): void {
  const missing = missingStagedFiles(stagedRoot, RN_UNIFFI_PACKAGE_NAME, RN_MODULE_FILES)
  const cppDir = join(stagedRoot, stagedPathOf(layoutOf(RN_UNIFFI_PACKAGE_NAME), RN_GENERATED_CPP_DIR) ?? RN_GENERATED_CPP_DIR)
  const hasGeneratedCpp = existsSync(cppDir) && listStagedFiles(cppDir).some((file) => file.endsWith('.cpp'))

  if (!hasGeneratedCpp) {
    missing.push(`${RN_GENERATED_CPP_DIR}/*.cpp`)
  }
  if (missing.length > 0) {
    throw new Error(`staged kizunasync is missing React Native module files (run the rn-uniffi \`ubrn:ios\` or \`ubrn:android\` script first):\n${missing.map((path) => `  ${path}`).join('\n')}`)
  }
}

function isSameFile(path: string, reference: string): boolean {
  return existsSync(path) && readFileSync(path).equals(readFileSync(reference))
}

/**
 * Fails the run when the staged `pack/` is not a byte-for-byte copy of the SQL
 * pack at `supabasePackRoot`: its manifest and every file the manifest lists.
 * A stale `pack/` means the `kizunasync` build did not run after the SQL changed.
 */
export function validateStagedPack(stagedRoot: string, supabasePackRoot: string): void {
  const manifestPath = join(supabasePackRoot, PACK_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { pack: string[] }
  const sources = new Map([[PACK_MANIFEST_FILE, manifestPath], ...manifest.pack.map((file): [string, string] => [file, join(supabasePackRoot, PACK_MIGRATIONS_DIR, file)])])
  const layout = layoutOf(PUBLIC_PACKAGE_NAME)
  const stale = [...sources]
    .map(([file, source]) => ({ staged: stagedPathOf(layout, `${PACKED_PACK_DIR}/${file}`) ?? `${PACKED_PACK_DIR}/${file}`, source }))
    .filter(({ staged, source }) => !isSameFile(join(stagedRoot, staged), source))
    .map(({ staged }) => staged)

  if (stale.length > 0) {
    throw new Error(`staged kizunasync pack/ is missing or differs from ${SUPABASE_PACK_DIR} (run \`bun run turbo run build --filter=kizunasync...\` first):\n${stale.map((file) => `  ${file}`).join('\n')}`)
  }
}

/** Fails the run when a published `exports` target is absent from the staged tree. */
export function validatePublishedExports(stagedRoot: string, exports: Record<string, TExportTarget>): void {
  const missing = exportTargets(exports).filter((target) => !existsSync(join(stagedRoot, target)))

  if (missing.length > 0) {
    throw new Error(`staged kizunasync is missing published exports targets:\n${missing.map((target) => `  ${target}`).join('\n')}`)
  }
}

function stagePublicPackage(version: string, outDir: string): void {
  const stagedRoot = join(outDir, PUBLIC_PACKAGE_NAME)
  const tmpDir = mkdtempSync(join(tmpdir(), 'kizunasync-npm-pack-'))

  mkdirSync(stagedRoot, { recursive: true })

  try {
    for (const layout of PUBLISHED_LAYOUT) {
      placeWorkspace(layout, packWorkspace(layout.dir, tmpDir), stagedRoot)
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  copyRootLicense(stagedRoot)

  const privateWorkspaces = PRIVATE_LAYOUT.map((layout) => ({ layout, pkg: readWorkspacePackageJson(layout.dir) }))
  const privatePackages = privateWorkspaces.map(({ pkg }) => pkg)

  rewriteStagedSpecifiers(stagedRoot, privateSpecifierTargets(privateWorkspaces.map(({ layout, pkg }) => ({ layout, exports: pkg.exports ?? {} }))))
  assertNoResidualPrivateSpecifiers(stagedRoot)

  const publicPackage = readWorkspacePackageJson(PUBLIC_PACKAGE_DIR)
  const pkg = composePublishedPackageJson({ version, publicPackage, privatePackages, files: stagedTopLevelFiles(stagedRoot) })

  writeFileSync(join(stagedRoot, PACKAGE_JSON_FILE), `${JSON.stringify(pkg, null, 2)}\n`)
  validateStagedWebAssets(stagedRoot)
  validateStagedReactNativeModule(stagedRoot)
  validateStagedPack(stagedRoot, join(REPO_ROOT, SUPABASE_PACK_DIR))
  validatePublishedExports(stagedRoot, pkg.exports ?? {})
}

// MARK: - Platform package generation

/** Below this a "binary" is almost certainly a zero-byte or truncated build artifact. */
const MIN_BINARY_SIZE_BYTES = 100_000

interface IBinaryIssues {
  missing: string[]
  tooSmall: Array<{ path: string; size: number }>
}

function collectBinaryIssues(binariesDir: string): IBinaryIssues {
  const missing: string[] = []
  const tooSmall: Array<{ path: string; size: number }> = []

  for (const target of PLATFORM_TARGETS) {
    const napiPath = join(binariesDir, target.triple, target.napiLibrary)
    const cliPath = join(binariesDir, target.triple, target.cliBinary)

    for (const path of [napiPath, cliPath]) {
      if (!existsSync(path)) {
        missing.push(path)
        continue
      }
      const size = statSync(path).size

      if (size < MIN_BINARY_SIZE_BYTES) {
        tooSmall.push({ path, size })
      }
    }
  }
  return { missing, tooSmall }
}

function reportBinaryIssues({ missing, tooSmall }: IBinaryIssues): void {
  if (missing.length > 0) {
    console.error('--binaries is missing:')

    for (const path of missing) {
      console.error(`  ${path}`)
    }
  }
  if (tooSmall.length > 0) {
    console.error(`--binaries has files under ${MIN_BINARY_SIZE_BYTES} bytes:`)

    for (const { path, size } of tooSmall) {
      console.error(`  ${path} (${size}b)`)
    }
  }
}

function validateBinariesDir(binariesDir: string): void {
  const issues = collectBinaryIssues(binariesDir)

  reportBinaryIssues(issues)

  if (issues.missing.length > 0 || issues.tooSmall.length > 0) {
    process.exit(1)
  }
}

/** `@kizunasync/core` -> `@kizunasync+core`; `kizunasync` -> `kizunasync`. */
function stagedDirName(packageName: string): string {
  return packageName.replace('/', '+')
}

function platformPackageName(target: IPlatformTarget): string {
  return `@kizunasync/${target.triple}`
}

interface IPlatformStagingOptions {
  target: IPlatformTarget
  version: string
  binariesDir: string
  outDir: string
}

function stagePlatformPackage({ target, version, binariesDir, outDir }: IPlatformStagingOptions): void {
  const name = platformPackageName(target)
  const destDir = join(outDir, stagedDirName(name))
  const cliPath = `bin/${target.cliBinary}`

  mkdirSync(join(destDir, 'bin'), { recursive: true })

  const engines = readWorkspacePackageJson(PUBLIC_PACKAGE_DIR).engines
  const pkg: IPackageJson = {
    name,
    version,
    description: `Kizuna Sync native binaries (CLI and N-API engine) for ${target.triple}`,
    license: 'Apache-2.0',
    repository: { type: 'git', url: REPOSITORY_URL, directory: PUBLIC_PACKAGE_DIR },
    os: [target.platform],
    cpu: [target.arch],
    ...(target.platform === 'linux' ? { libc: ['glibc'] } : {}),
    ...(engines !== undefined ? { engines } : {}),
    files: [cliPath, target.napiLibrary, LICENSE_FILE],
    publishConfig: { access: 'public' },
  }

  writeFileSync(join(destDir, PACKAGE_JSON_FILE), `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(join(destDir, 'README.md'), `Native binaries for kizunasync on ${target.triple}, installed automatically as one of its optional dependencies.\n`)
  copyRootLicense(destDir)
  cpSync(join(binariesDir, target.triple, target.napiLibrary), join(destDir, target.napiLibrary))
  cpSync(join(binariesDir, target.triple, target.cliBinary), join(destDir, cliPath))
  chmodSync(join(destDir, cliPath), 0o755)
}

// MARK: - publish-order.txt and summary

function writePublishOrder(outDir: string, hasBinaries: boolean): void {
  const platformDirs = hasBinaries ? PLATFORM_TARGETS.map((target) => stagedDirName(platformPackageName(target))) : []

  writeFileSync(join(outDir, 'publish-order.txt'), `${[...platformDirs, PUBLIC_PACKAGE_NAME].join('\n')}\n`)
}

interface ISummaryRow {
  name: string
  version: string
  fileCount: number
  unpackedSize: number
}

function packDryRun(packageDir: string): ISummaryRow {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageDir,
    encoding: 'utf8',
  })
  const [result] = JSON.parse(output) as Array<{ name: string; version: string; entryCount: number; unpackedSize: number }>

  if (result === undefined) {
    throw new Error(`npm pack --dry-run produced no result for ${packageDir}`)
  }
  return { name: result.name, version: result.version, fileCount: result.entryCount, unpackedSize: result.unpackedSize }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function printSummary(outDir: string): void {
  const entries = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'smoke')
    .map((entry) => entry.name)
    .sort()

  const rows = entries.map((entry) => packDryRun(join(outDir, entry)))
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length))
  const versionWidth = Math.max(7, ...rows.map((row) => row.version.length))
  const filesWidth = Math.max(5, ...rows.map((row) => String(row.fileCount).length))

  console.log('')
  console.log(`${'NAME'.padEnd(nameWidth)}  ${'VERSION'.padEnd(versionWidth)}  ${'FILES'.padStart(filesWidth)}  SIZE`)

  for (const row of rows) {
    console.log(
      `${row.name.padEnd(nameWidth)}  ${row.version.padEnd(versionWidth)}  ${String(row.fileCount).padStart(filesWidth)}  ${formatBytes(row.unpackedSize)}`,
    )
  }
}

// MARK: - Smoke test

const NODE_SMOKE_SPECIFIERS = ['kizunasync', 'kizunasync/config', 'kizunasync/constants', 'kizunasync/testing', 'kizunasync/supabase', 'kizunasync/react', 'kizunasync/vue']

/** Optional peers the Node smoke imports load. */
const SMOKE_PEERS = ['react', 'vue', '@supabase/supabase-js']

/**
 * The real directory of `name`, resolved from the workspace at `declaringWorkspace`
 * (not the repository root; bun's isolated linker does not hoist there). Falls
 * back to `<declaringWorkspace>/node_modules/<name>` when `require.resolve` fails
 * because the package's own `exports` hides its `package.json` subpath.
 */
function resolveExternalDependencyDir(name: string, declaringWorkspace: string): string | undefined {
  try {
    const packageJsonPath = createRequire(join(declaringWorkspace, PACKAGE_JSON_FILE)).resolve(`${name}/package.json`)

    return dirname(packageJsonPath)
  } catch {
    const fallback = join(declaringWorkspace, 'node_modules', name)

    return existsSync(fallback) ? fallback : undefined
  }
}

/** `name` from the first workspace `kizunasync` is assembled from that installed it. */
function resolveFromWorkspaces(name: string): string {
  for (const { dir } of PUBLISHED_LAYOUT) {
    const source = resolveExternalDependencyDir(name, join(REPO_ROOT, dir))

    if (source !== undefined) {
      return source
    }
  }
  throw new Error(`smoke tree: no workspace kizunasync is assembled from installed ${name}`)
}

function platformTargetOfHost(): IPlatformTarget | undefined {
  return PLATFORM_TARGETS.find((target) => target.platform === process.platform && target.arch === process.arch)
}

/**
 * `<out>/smoke/node_modules`: a copy of the staged `kizunasync` (and of this
 * host's platform package), as an install lays them out, plus symlinks to its
 * dependencies and SMOKE_PEERS from the workspaces that installed them. A copy,
 * not a symlink: Node resolves a package's own imports from its real location.
 */
function buildSmokeTree(outDir: string, hostTarget: IPlatformTarget | undefined): string {
  const smokeDir = join(outDir, 'smoke')
  const modules = join(smokeDir, 'node_modules')
  const installed = join(modules, PUBLIC_PACKAGE_NAME)

  rmSync(smokeDir, { recursive: true, force: true })
  mkdirSync(join(modules, '.bin'), { recursive: true })
  cpSync(join(outDir, PUBLIC_PACKAGE_NAME), installed, { recursive: true })

  if (hostTarget !== undefined) {
    cpSync(join(outDir, stagedDirName(platformPackageName(hostTarget))), join(modules, platformPackageName(hostTarget)), { recursive: true })
  }

  const pkg = readStagedPackageJson(installed)

  // An install marks bin targets executable whatever mode the tarball recorded.
  for (const [command, entry] of Object.entries(pkg.bin ?? {})) {
    chmodSync(join(installed, entry), 0o755)
    symlinkSync(posix.join('..', PUBLIC_PACKAGE_NAME, entry), join(modules, '.bin', command))
  }
  for (const name of [...Object.keys(pkg.dependencies ?? {}), ...SMOKE_PEERS]) {
    mkdirSync(dirname(join(modules, name)), { recursive: true })
    symlinkSync(resolveFromWorkspaces(name), join(modules, name), 'dir')
  }
  return smokeDir
}

function readStagedPackageJson(packageDir: string): IPackageJson {
  return JSON.parse(readFileSync(join(packageDir, PACKAGE_JSON_FILE), 'utf8')) as IPackageJson
}

interface ISmokeRun {
  label: string
  command: string
  args: string[]
}

function runSmokeStep(smokeDir: string, { label, command, args }: ISmokeRun): void {
  const result = spawnSync(command, args, { cwd: smokeDir, encoding: 'utf8' })

  console.log(result.stdout)

  if (result.stderr.length > 0) {
    console.error(result.stderr)
  }
  if (result.status !== 0) {
    throw new Error(`smoke ${label} failed with exit code ${String(result.status)} (see stderr above)`)
  }
}

function importCountsScript(specifiers: string[]): string {
  return `
const specifiers = ${JSON.stringify(specifiers)}
for (const specifier of specifiers) {
  const mod = await import(specifier)
  console.log(specifier, Object.keys(mod).length)
}
`
}

function runSmokeTest(outDir: string, hasBinaries: boolean): void {
  const hostTarget = hasBinaries ? platformTargetOfHost() : undefined
  const smokeDir = buildSmokeTree(outDir, hostTarget)

  runSmokeStep(smokeDir, { label: 'node import', command: 'node', args: ['--input-type=module', '-e', importCountsScript(NODE_SMOKE_SPECIFIERS)] })
  runSmokeStep(smokeDir, { label: 'require.resolve', command: 'node', args: ['-e', `console.log(require.resolve('${PUBLIC_PACKAGE_NAME}/package.json'))`] })

  if (hostTarget !== undefined) {
    runSmokeStep(smokeDir, { label: 'kizunasync --version', command: join(smokeDir, 'node_modules', '.bin', PUBLIC_PACKAGE_NAME), args: ['--version'] })
  }
}

// MARK: - main

async function main(): Promise<void> {
  const { version, binariesDir, outDir: outDirArg, smoke } = parseArgs(process.argv.slice(2))
  const outDir = resolve(process.cwd(), outDirArg)
  const resolvedBinariesDir = binariesDir === undefined ? undefined : resolve(process.cwd(), binariesDir)

  if (resolvedBinariesDir !== undefined) {
    validateBinariesDir(resolvedBinariesDir)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  stagePublicPackage(version, outDir)

  if (resolvedBinariesDir !== undefined) {
    for (const target of PLATFORM_TARGETS) {
      stagePlatformPackage({ target, version, binariesDir: resolvedBinariesDir, outDir })
    }
  }

  writePublishOrder(outDir, resolvedBinariesDir !== undefined)
  printSummary(outDir)

  if (smoke) {
    runSmokeTest(outDir, resolvedBinariesDir !== undefined)
  }
}

if (import.meta.main) {
  await main()
}
