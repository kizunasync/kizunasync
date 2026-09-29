/**
 * prepare-npm-release: stage every publishable @kizunasync/* package, plus the
 * generated per-platform N-API/CLI packages, into `<out>/` with versions and
 * `publishConfig` applied, ready for `npm publish` in `publish-order.txt`
 * order. Run from the repository root:
 *
 *   bun scripts/prepare-npm-release.ts <version> [--binaries <dir>] [--out dist/npm] [--smoke]
 *
 * `--binaries <dir>` must contain `<dir>/<triple>/<N-API library file>` and
 * `<dir>/<triple>/<CLI binary file>` for every triple in PLATFORM_TARGETS;
 * without it, only the eight source workspace packages are staged.
 * `bun run cargo:wasm` must have produced the `@kizunasync/web` glue first, whatever
 * `--binaries` is given. `--smoke` builds a throwaway `node_modules` tree under
 * `<out>/smoke` and imports/execs the staged output.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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

interface IWorkspacePackage {
  name: string
  dir: string
}

/** Fixed publish order: dependencies before dependents. */
const WORKSPACE_PACKAGES: IWorkspacePackage[] = [
  { name: '@kizunasync/core', dir: 'packages/core' },
  { name: '@kizunasync/supabase', dir: 'packages/supabase' },
  { name: '@kizunasync/web', dir: 'packages/web' },
  { name: '@kizunasync/react', dir: 'packages/react' },
  { name: '@kizunasync/vue', dir: 'packages/vue' },
  { name: '@kizunasync/expo', dir: 'packages/expo' },
  { name: '@kizunasync/rn-uniffi', dir: 'packages/rn-uniffi' },
  { name: 'kizunasync', dir: 'packages/cli' },
]

/**
 * What a usable `@kizunasync/web` carries. The two `.d.ts` files are tracked, but
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

/** `@kizunasync/core/testing` is Bun-only by design (imports `bun:sqlite`); run it separately with `bun`. */
const BUN_ONLY_SMOKE_SPECIFIER = '@kizunasync/core/testing'
const NODE_SMOKE_SPECIFIERS = ['@kizunasync/core', '@kizunasync/core/config', '@kizunasync/core/constants', '@kizunasync/supabase', '@kizunasync/react', '@kizunasync/vue']

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

// MARK: - Package.json rewriting

type TDependencyMap = Record<string, string>

interface IPublishConfig {
  access?: string
  main?: string
  types?: string
  exports?: unknown
  optionalDependencies?: TDependencyMap
}

interface IPackageJson {
  name: string
  version: string
  main?: string
  types?: string
  exports?: unknown
  dependencies?: TDependencyMap
  peerDependencies?: TDependencyMap
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: TDependencyMap
  devDependencies?: TDependencyMap
  scripts?: Record<string, string>
  publishConfig?: IPublishConfig
  [key: string]: unknown
}

const WORKSPACE_RANGE = /^workspace:[*^~]?$/

function pinWorkspaceRanges(deps: TDependencyMap | undefined, version: string): void {
  if (deps === undefined) {
    return
  }
  for (const [name, range] of Object.entries(deps)) {
    if (WORKSPACE_RANGE.test(range)) {
      deps[name] = version
    }
  }
}

/** Copies `main`/`types`/`exports` from `publishConfig` onto the staged `package.json`, when set. */
function applyPublishConfigEntryPoints(pkg: IPackageJson, publishConfig: IPublishConfig | undefined): void {
  if (publishConfig?.main !== undefined) {
    pkg.main = publishConfig.main
  }
  if (publishConfig?.types !== undefined) {
    pkg.types = publishConfig.types
  }
  if (publishConfig?.exports !== undefined) {
    pkg.exports = publishConfig.exports
  }
}

/** `publishConfig.optionalDependencies` names, each pinned to `version`; undefined when `publishConfig` declares none. */
function pinPublishConfigOptionalDependencies(publishConfig: IPublishConfig | undefined, version: string): TDependencyMap | undefined {
  if (publishConfig?.optionalDependencies === undefined) {
    return undefined
  }
  const pinned: TDependencyMap = {}

  for (const name of Object.keys(publishConfig.optionalDependencies)) {
    pinned[name] = version
  }
  return pinned
}

/** Pins workspace ranges, copies `publishConfig` entry points onto the staged `package.json`, and drops private-only fields. */
function rewriteStagedPackageJson(packageDir: string, version: string): void {
  const packageJsonPath = join(packageDir, 'package.json')
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as IPackageJson

  pkg.version = version

  const publishConfig = pkg.publishConfig

  applyPublishConfigEntryPoints(pkg, publishConfig)

  pinWorkspaceRanges(pkg.dependencies, version)
  pinWorkspaceRanges(pkg.peerDependencies, version)
  pinWorkspaceRanges(pkg.optionalDependencies, version)
  pinWorkspaceRanges(pkg.devDependencies, version)

  delete pkg.devDependencies
  delete pkg.scripts

  const pinnedOptionalDependencies = pinPublishConfigOptionalDependencies(publishConfig, version)

  if (pinnedOptionalDependencies !== undefined) {
    pkg.optionalDependencies = pinnedOptionalDependencies
  }

  if (publishConfig !== undefined) {
    pkg.publishConfig = { access: publishConfig.access ?? 'public' }
  }

  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

/** `@kizunasync/core` -> `@kizunasync+core`; `kizunasync` -> `kizunasync`. */
function stagedDirName(packageName: string): string {
  return packageName.replace('/', '+')
}

function stageWorkspacePackage(pkg: IWorkspacePackage, version: string, outDir: string, tmpDir: string): void {
  const sourceDir = join(REPO_ROOT, pkg.dir)
  const packOutput = execFileSync('npm', ['pack', '--pack-destination', tmpDir, '--ignore-scripts', '--json'], {
    cwd: sourceDir,
    encoding: 'utf8',
  })
  const [packed] = JSON.parse(packOutput) as Array<{ filename: string }>

  if (packed === undefined) {
    throw new Error(`npm pack produced no tarball for ${pkg.name}`)
  }

  const tarballPath = join(tmpDir, packed.filename)
  const extractDir = mkdtempSync(join(tmpDir, 'extract-'))

  execFileSync('tar', ['-xzf', tarballPath, '-C', extractDir])

  const destDir = join(outDir, stagedDirName(pkg.name))

  cpSync(join(extractDir, 'package'), destDir, { recursive: true })
  rmSync(extractDir, { recursive: true, force: true })

  rewriteStagedPackageJson(destDir, version)
}

function validateStagedWebPackage(outDir: string): void {
  const webDir = join(outDir, stagedDirName('@kizunasync/web'))
  const missing = WEB_WASM_ASSETS.filter((asset) => !existsSync(join(webDir, asset)))

  if (missing.length === 0) {
    return
  }
  console.error('staged @kizunasync/web is missing its wasm glue (run `bun run cargo:wasm` first):')

  for (const asset of missing) {
    console.error(`  ${join(webDir, asset)}`)
  }
  process.exit(1)
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

function readCliEngines(): Record<string, string> | undefined {
  const cliPackageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/cli/package.json'), 'utf8')) as IPackageJson

  return cliPackageJson.engines as Record<string, string> | undefined
}

function platformPackageReadme(name: string, parentName: string): string {
  return `# ${name}\nPlatform binary for ${parentName}, installed automatically as its optional dependency.\n`
}

function stageNapiPlatformPackage(target: IPlatformTarget, version: string, binariesDir: string, outDir: string): void {
  const name = `@kizunasync/napi-${target.triple}`
  const destDir = join(outDir, stagedDirName(name))

  mkdirSync(destDir, { recursive: true })

  const pkg: IPackageJson = {
    name,
    version,
    description: `Kizuna Sync N-API engine for ${target.triple}`,
    license: 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'https://github.com/kizunasync/kizunasync.git',
      directory: 'packages/core',
    },
    os: [target.platform],
    cpu: [target.arch],
    ...(target.platform === 'linux' ? { libc: ['glibc'] } : {}),
    files: [target.napiLibrary],
    publishConfig: { access: 'public' },
  }

  writeFileSync(join(destDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(join(destDir, 'README.md'), platformPackageReadme(name, '@kizunasync/core'))
  cpSync(join(binariesDir, target.triple, target.napiLibrary), join(destDir, target.napiLibrary))
}

function stageCliPlatformPackage(target: IPlatformTarget, version: string, binariesDir: string, outDir: string): void {
  const name = `@kizunasync/cli-${target.triple}`
  const destDir = join(outDir, stagedDirName(name))

  mkdirSync(join(destDir, 'bin'), { recursive: true })

  const engines = readCliEngines()
  const pkg: IPackageJson = {
    name,
    version,
    description: `Kizuna Sync CLI binary for ${target.triple}`,
    license: 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'https://github.com/kizunasync/kizunasync.git',
      directory: 'packages/cli',
    },
    os: [target.platform],
    cpu: [target.arch],
    ...(target.platform === 'linux' ? { libc: ['glibc'] } : {}),
    ...(engines !== undefined ? { engines } : {}),
    files: ['bin'],
    publishConfig: { access: 'public' },
  }

  writeFileSync(join(destDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(join(destDir, 'README.md'), platformPackageReadme(name, 'kizunasync'))
  const binDest = join(destDir, 'bin', target.cliBinary)

  cpSync(join(binariesDir, target.triple, target.cliBinary), binDest)
  chmodSync(binDest, 0o755)
}

// MARK: - publish-order.txt and summary

function writePublishOrder(outDir: string, hasBinaries: boolean): void {
  const lines: string[] = []

  if (hasBinaries) {
    for (const target of PLATFORM_TARGETS) {
      lines.push(stagedDirName(`@kizunasync/napi-${target.triple}`))
    }
    for (const target of PLATFORM_TARGETS) {
      lines.push(stagedDirName(`@kizunasync/cli-${target.triple}`))
    }
  }
  for (const pkg of WORKSPACE_PACKAGES) {
    lines.push(stagedDirName(pkg.name))
  }
  writeFileSync(join(outDir, 'publish-order.txt'), `${lines.join('\n')}\n`)
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

/**
 * `<out>/node_modules/`: sibling of the staged `@kizunasync+*` directories, only
 * created when `--smoke` is given. It never touches what `publish-order.txt`
 * names for publishing (package directories only). Node's default ESM
 * resolver realpaths a symlinked entry point on load. Every bare import from
 * a file *inside* a staged package (its own `dependencies`, or a sibling
 * `@kizunasync/*` import) is resolved against that package's real, staged location,
 * `<out>/@kizunasync+core/dist/…`, not the symlink through which it was first
 * reached. The nearest common ancestor of every staged package's real
 * location is `<out>/` itself. The symlinks must live there, or the ancestor
 * walk never finds them. `<out>/smoke/` stays the harness's cwd: Node's
 * ancestor walk from a subdirectory also reaches `<out>/node_modules/`.
 */
function smokeNodeModulesRoot(outDir: string): string {
  return join(outDir, 'node_modules')
}

function buildSmokeTree(outDir: string): void {
  const smokeDir = join(outDir, 'smoke')
  const outModules = smokeNodeModulesRoot(outDir)

  rmSync(smokeDir, { recursive: true, force: true })
  rmSync(outModules, { recursive: true, force: true })
  mkdirSync(smokeDir, { recursive: true })
  mkdirSync(join(outModules, '@kizunasync'), { recursive: true })

  const stagedEntries = readdirSync(outDir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name !== 'smoke',
  )

  for (const entry of stagedEntries) {
    if (entry.name === 'kizunasync') {
      symlinkSync(join(outDir, entry.name), join(outModules, 'kizunasync'), 'dir')
      continue
    }
    if (entry.name.startsWith('@kizunasync+')) {
      const scopedName = entry.name.slice('@kizunasync+'.length)

      symlinkSync(join(outDir, entry.name), join(outModules, '@kizunasync', scopedName), 'dir')
    }
  }

  symlinkExternalDependencies(outDir, outModules)
}

function isKizunaSyncPackageName(name: string): boolean {
  return name === 'kizunasync' || name.startsWith('@kizunasync/')
}

/**
 * `name`'s real directory, resolved from whichever workspace `pkg` declares
 * it in. Undefined for an unresolvable optional peer (logged, not staged);
 * throws for any other unresolvable dependency.
 */
function resolveDeclaredDependency(name: string, stagedPkg: IPackageJson, pkg: IWorkspacePackage): string | undefined {
  const declaringWorkspace = join(REPO_ROOT, pkg.dir)
  const source = resolveExternalDependencyDir(name, declaringWorkspace)

  if (source !== undefined) {
    return source
  }
  if (stagedPkg.peerDependenciesMeta?.[name]?.optional === true) {
    console.log(`smoke tree: optional peer ${name} not installed, skipped`)

    return undefined
  }
  throw new Error(`smoke tree: cannot resolve external dependency "${name}" declared by ${pkg.name} (${pkg.dir})`)
}

/**
 * Every staged workspace package's `dependencies` ∪ `peerDependencies`, minus
 * `kizunasync` and `@kizunasync/*` (those are already symlinked above), resolved from
 * wherever the declaring workspace installed it. `react` / `vue` /
 * `@supabase/supabase-js` (and every other external dependency) are not
 * hoisted to the top-level repository `node_modules` under bun's isolated
 * linker (`bunfig.toml`); each lives only inside the workspace that declares
 * it, as a symlink into the shared `node_modules/.bun/<pkg>@<version>/…` store.
 */
function collectExternalDependencies(outDir: string): Map<string, string> {
  const resolved = new Map<string, string>()

  for (const pkg of WORKSPACE_PACKAGES) {
    const stagedPackageJsonPath = join(outDir, stagedDirName(pkg.name), 'package.json')
    const stagedPkg = JSON.parse(readFileSync(stagedPackageJsonPath, 'utf8')) as IPackageJson
    const names = new Set([...Object.keys(stagedPkg.dependencies ?? {}), ...Object.keys(stagedPkg.peerDependencies ?? {})])

    for (const name of names) {
      if (isKizunaSyncPackageName(name) || resolved.has(name)) {
        continue
      }
      const source = resolveDeclaredDependency(name, stagedPkg, pkg)

      if (source !== undefined) {
        resolved.set(name, source)
      }
    }
  }

  return resolved
}

function symlinkExternalDependencies(outDir: string, outModules: string): void {
  const resolved = collectExternalDependencies(outDir)

  for (const [name, source] of resolved) {
    const dest = join(outModules, name)

    mkdirSync(join(dest, '..'), { recursive: true })
    symlinkSync(source, dest, 'dir')
  }
}

/**
 * The real directory of `name`, resolved from the workspace at `declaringWorkspace`
 * (not the repository root; bun's isolated linker does not hoist there). Falls
 * back to `<declaringWorkspace>/node_modules/<name>` when `require.resolve` fails
 * because the package's own `exports` hides its `package.json` subpath.
 */
function resolveExternalDependencyDir(name: string, declaringWorkspace: string): string | undefined {
  try {
    const packageJsonPath = createRequire(join(declaringWorkspace, 'package.json')).resolve(`${name}/package.json`)

    return dirname(packageJsonPath)
  } catch {
    const fallback = join(declaringWorkspace, 'node_modules', name)

    return existsSync(fallback) ? fallback : undefined
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

function runSmokeImports(outDir: string): void {
  const smokeDir = join(outDir, 'smoke')

  const nodeResult = spawnSync('node', ['--input-type=module', '-e', importCountsScript(NODE_SMOKE_SPECIFIERS)], {
    cwd: smokeDir,
    encoding: 'utf8',
  })

  console.log(nodeResult.stdout)

  if (nodeResult.stderr.length > 0) {
    console.error(nodeResult.stderr)
  }
  if (nodeResult.status !== 0) {
    throw new Error('smoke import failed under node (see stderr above)')
  }

  // `@kizunasync/core/testing` imports `bun:sqlite` by design; only Bun can load it.
  const bunResult = spawnSync('bun', ['-e', importCountsScript([BUN_ONLY_SMOKE_SPECIFIER])], {
    cwd: smokeDir,
    encoding: 'utf8',
  })

  console.log(bunResult.stdout)

  if (bunResult.stderr.length > 0) {
    console.error(bunResult.stderr)
  }
  if (bunResult.status !== 0) {
    throw new Error('smoke import failed under bun (see stderr above)')
  }
}

function runSmokeCli(outDir: string): void {
  const smokeDir = join(outDir, 'smoke')
  const cliEntry = join(smokeNodeModulesRoot(outDir), 'kizunasync', 'dist', 'main.js')
  const result = spawnSync('node', [cliEntry, '--help'], { cwd: smokeDir, encoding: 'utf8' })

  console.log(`kizunasync --help exit code: ${String(result.status)}`)
  console.log(result.stdout)

  if (result.stderr.length > 0) {
    console.log(result.stderr)
  }
  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`unexpected kizunasync --help exit code: ${String(result.status)}`)
  }
}

function runSmokeTest(outDir: string): void {
  buildSmokeTree(outDir)
  runSmokeImports(outDir)
  runSmokeCli(outDir)
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

  const tmpDir = mkdtempSync(join(tmpdir(), 'kizunasync-npm-pack-'))

  try {
    for (const pkg of WORKSPACE_PACKAGES) {
      stageWorkspacePackage(pkg, version, outDir, tmpDir)
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  validateStagedWebPackage(outDir)

  if (resolvedBinariesDir !== undefined) {
    for (const target of PLATFORM_TARGETS) {
      stageNapiPlatformPackage(target, version, resolvedBinariesDir, outDir)
      stageCliPlatformPackage(target, version, resolvedBinariesDir, outDir)
    }
  }

  writePublishOrder(outDir, resolvedBinariesDir !== undefined)
  printSummary(outDir)

  if (smoke) {
    runSmokeTest(outDir)
  }
}

await main()
