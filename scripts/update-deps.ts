import { execSync, spawnSync } from 'child_process'
import { readdirSync, existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { withCargoToolsOnPath } from './lib/cargo-tools'
import { cargoOnPath, isRustSkipped } from './lib/rust-env'

const ROOT = resolve(import.meta.dir, '..')

/**
 * Every workspace base declared in the root package.json `workspaces` field.
 * `examples` belongs here: left out, the example apps drift behind the packages
 * they consume, which CONVENTIONS forbids ("a dependency shared by multiple
 * workspaces uses the same version/range").
 */
const WORKSPACE_BASES = ['apps', 'packages', 'examples']

const INSTALL_CARGO_EDIT = 'cargo install cargo-edit --root .cargo-tools'

/** The `name` field at `pkgJsonPath`, or undefined when missing, unparsable, or unnamed. */
function readWorkspacePackageName(pkgJsonPath: string): string | undefined {
  if (!existsSync(pkgJsonPath)) {
    return undefined
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown }

    return typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : undefined
  } catch {
    // ignore non-parsable package.json files
    return undefined
  }
}

function collectWorkspacePackageNames(bases: string[]): string[] {
  const names = new Set<string>()

  for (const base of bases) {
    const baseDir = join(ROOT, base)

    if (!existsSync(baseDir)) {
      continue
    }

    const entries = readdirSync(baseDir, { withFileTypes: true }).filter((dirent) =>
      dirent.isDirectory(),
    )

    for (const entry of entries) {
      const name = readWorkspacePackageName(join(baseDir, entry.name, 'package.json'))

      if (name !== undefined) {
        names.add(name)
      }
    }
  }

  return [...names]
}

function buildNcuCommand(rejectList: string[]): string {
  const base = 'ncu -t minor -u'

  if (rejectList.length === 0) {
    return base
  }

  return `${base} --reject "${rejectList.join(',')}"`
}

function runInDirectory(dir: string, command: string) {
  console.log(`\n📂 Running in: ${dir}`)

  try {
    execSync(command, {
      cwd: dir,
      stdio: 'inherit',
    })
    console.log(`✅ Completed: ${dir}`)
  } catch (error) {
    console.error(`❌ Error in ${dir}:`, error instanceof Error ? error.message : String(error))
  }

  console.log('────────────────────────────────────')
}

/** Whether the `cargo-edit` plugin (`cargo upgrade`) resolves on PATH or in `.cargo-tools/bin`. */
function cargoUpgradeAvailable(): boolean {
  return spawnSync('cargo', ['upgrade', '--version'], {
    encoding: 'utf8',
    env: withCargoToolsOnPath(process.env),
  }).status === 0
}

function runCargo(args: string[]): number {
  const printed = `cargo ${args.join(' ')}`

  console.log(`\n📂 Running in: ${ROOT}`)
  console.log(`$ ${printed}`)
  const result = spawnSync('cargo', args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: withCargoToolsOnPath(process.env),
  })
  const status = result.status ?? 1

  if (status === 0) {
    console.log(`✅ Completed: ${printed}`)
  } else {
    console.error(`❌ Error in ${printed} (exit ${status})`)
  }
  console.log('────────────────────────────────────')

  return status
}

/**
 * One Cargo workspace at the repo root (`crates/*`). `cargo upgrade` rewrites
 * `Cargo.toml` the way `ncu -u` rewrites `package.json`; default is compatible
 * only (the `-t minor` analogue). `cargo update` then refreshes `Cargo.lock`.
 * Not a Turbo task: it mutates manifests, needs the `cargo-edit` plugin, and
 * must run once for the workspace rather than per crate.
 */
function updateCargoWorkspace(): number {
  if (isRustSkipped()) {
    console.log('\n[update-deps] skip Cargo (KSYNC_SKIP_RUST=1)')

    return 0
  }

  if (!existsSync(join(ROOT, 'Cargo.toml'))) {
    console.log('\n[update-deps] no Cargo.toml at repo root, skip Cargo')

    return 0
  }

  if (!cargoOnPath()) {
    console.log('\n[update-deps] cargo not on PATH, skip Cargo')

    return 0
  }

  if (!cargoUpgradeAvailable()) {
    console.log(
      `\n[update-deps] cargo-edit not found on PATH or in .cargo-tools/bin, skip Cargo. Install with \`${INSTALL_CARGO_EDIT}\``,
    )

    return 0
  }

  console.log('\n🦀 Cargo workspace (compatible `cargo upgrade`, then `cargo update`)\n')
  const upgradeStatus = runCargo(['upgrade'])

  if (upgradeStatus !== 0) {
    return upgradeStatus
  }
  return runCargo(['update'])
}

function updateJavascriptWorkspaces() {
  console.log('🚀 Starting dependency update with npm-check-updates...\n')

  const workspaceNames = collectWorkspacePackageNames(WORKSPACE_BASES)

  if (workspaceNames.length > 0) {
    console.log(
      `🧩 Internal workspace packages excluded from ncu (${workspaceNames.length}): ${workspaceNames.join(', ')}\n`,
    )
  }
  const command = buildNcuCommand(workspaceNames)

  runInDirectory(ROOT, command)

  for (const base of WORKSPACE_BASES) {
    const baseDir = join(ROOT, base)

    if (!existsSync(baseDir)) {
      console.log(`⚠️ Folder not found: ${base}`)
      continue
    }

    const entries = readdirSync(baseDir, { withFileTypes: true }).filter((dirent) =>
      dirent.isDirectory(),
    )

    for (const entry of entries) {
      const fullPath = join(baseDir, entry.name)
      const packageJsonPath = join(fullPath, 'package.json')

      if (existsSync(packageJsonPath)) {
        runInDirectory(fullPath, command)
      } else {
        console.log(`⚠️ Skipped (no package.json): ${fullPath}`)
      }
    }
  }
}

function main() {
  updateJavascriptWorkspaces()
  const cargoStatus = updateCargoWorkspace()

  if (cargoStatus !== 0) {
    console.error('\nCargo dependency update failed.')
    process.exit(cargoStatus)
  }

  console.log('\n🎉 Update completed!')
}

main()
