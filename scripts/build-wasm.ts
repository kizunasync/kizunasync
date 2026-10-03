/**
 * Build the browser engine and emit the wasm-bindgen glue packages/web loads.
 *
 * Usage (repository root):
 *   bun run cargo:wasm
 *
 * Three stages: cargo builds kizunasync-wasm for wasm32 on the release-size profile,
 * wasm-bindgen writes the module plus its TypeScript declarations into
 * packages/web/src/wasm, and wasm-opt shrinks the binary in place. wasm-opt is
 * optional locally and required in CI. A size regression that only appears on
 * the release lane is one nobody sees until it ships.
 *
 * The wasm-bindgen CLI must match the wasm-bindgen crate in Cargo.lock exactly.
 * A mismatch produces glue the module cannot instantiate. This refuses to run;
 * it does not emit a broken artifact.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { cargoToolsBin } from './lib/cargo-tools'

const root = resolve(import.meta.dir, '..')
const outDir = resolve(root, 'packages/web/src/wasm')
const artifact = resolve(root, 'target/wasm32-unknown-unknown/release-size/kizunasync_wasm.wasm')
const bundled = resolve(outDir, 'kizunasync_wasm_bg.wasm')

/** Locally installed cargo binaries the repository does not put on PATH. */
const toolsBin = cargoToolsBin()

/**
 * sqlite-wasm-rs's shim uses the C23 `[[noreturn]]` attribute, and its build
 * script sets no `-std`. Linux clang defaults to gnu17 and rejects it; `gnu2x`
 * is Clang 14's spelling of GNU C23, and later clangs accept it too.
 */
const DEFAULT_WASM_CFLAGS = '-std=gnu2x'

function run(cmd: string, args: string[], label: string, env?: NodeJS.ProcessEnv): void {
  console.log(`[build-wasm] ${label}`)
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: env ?? process.env })

  if (result.status !== 0) {
    console.error(`[build-wasm] ${label} failed`)
    process.exit(result.status ?? 1)
  }
}

/** The binary's own `--version` line, or null when it cannot be executed. */
function probeVersion(bin: string): string | null {
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' })

  if (probe.status !== 0 || typeof probe.stdout !== 'string') return null

  return probe.stdout.trim()
}

/** `llvm-ar` shipped with the active toolchain's `llvm-tools` component. */
function hostLlvmAr(): string | null {
  const sysroot = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' })
  const verbose = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })

  if (sysroot.status !== 0 || verbose.status !== 0) return null

  const host = /^host: (.+)$/m.exec(verbose.stdout)?.[1]

  if (host === undefined) return null

  const candidate = resolve(sysroot.stdout.trim(), 'lib/rustlib', host, 'bin/llvm-ar')

  return existsSync(candidate) ? candidate : null
}

/** Resolve a runnable binary on PATH, then in the repository-local install root. */
function locate(bin: string): string | null {
  if (probeVersion(bin) !== null) return bin
  const vendored = resolve(toolsBin, bin)

  return existsSync(vendored) && probeVersion(vendored) !== null ? vendored : null
}

/**
 * The wasm-bindgen crate version Cargo resolved. The CLI is pinned to it, so
 * reading the lock file keeps the pin honest after a dependency bump.
 */
function lockedBindgenVersion(): string {
  const lock = readFileSync(resolve(root, 'Cargo.lock'), 'utf8')
  const match = /\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)

  if (match?.[1] === undefined) {
    throw new Error('Cargo.lock declares no wasm-bindgen package')
  }
  return match[1]
}

const version = lockedBindgenVersion()
const install = `cargo install wasm-bindgen-cli --version ${version}`

const bindgen = locate('wasm-bindgen')

if (bindgen === null) {
  console.error(`[build-wasm] wasm-bindgen CLI not found. Install the pinned one:\n  ${install}`)
  process.exit(1)
}

const installed = probeVersion(bindgen)

if (installed === null || !installed.endsWith(version)) {
  console.error(
    `[build-wasm] ${installed} does not match wasm-bindgen ${version} in Cargo.lock.\n  ${install}`,
  )
  process.exit(1)
}

/**
 * Apple's `ar` writes an empty archive for WebAssembly objects, so
 * `sqlite-wasm-rs` links an empty `libwsqlite3.a` and the sqlite symbols
 * survive as `import "env"`. `llvm-ar` from the `llvm-tools` rustup component
 * archives them. Rust 1.95 also emits an exception-tag import when panics
 * unwind; aborting keeps that out of the browser glue.
 */
const llvmAr = hostLlvmAr()

if (llvmAr === null) {
  console.error(
    '[build-wasm] llvm-ar not found. Install it with:\n  rustup component add llvm-tools',
  )
  process.exit(1)
}

run(
  'cargo',
  ['build', '-p', 'kizunasync-wasm', '--target', 'wasm32-unknown-unknown', '--profile', 'release-size'],
  'cargo build (wasm32, release-size)',
  {
    ...process.env,
    AR: llvmAr,
    AR_wasm32_unknown_unknown: llvmAr,
    CFLAGS_wasm32_unknown_unknown: process.env.CFLAGS_wasm32_unknown_unknown ?? DEFAULT_WASM_CFLAGS,
    RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} -C panic=abort`.trim(),
  },
)

mkdirSync(outDir, { recursive: true })
run(
  bindgen,
  [artifact, '--target', 'web', '--typescript', '--out-dir', outDir],
  'wasm-bindgen (target web)',
)

/**
 * Oldest binaryen whose validator accepts, together, the six features rustc
 * 1.82+ enables by default for wasm32-unknown-unknown. Ubuntu 22.04's apt
 * package (105) is below it, so CI installs a pinned release instead.
 */
const MIN_BINARYEN = 116

/** The integer version binaryen reports, or null when it cannot be read. */
function binaryenVersion(bin: string): number | null {
  const reported = probeVersion(bin)
  const match = reported === null ? null : /(\d+)/.exec(reported)

  return match?.[1] === undefined ? null : Number(match[1])
}

const before = statSync(bundled).size
const opt = locate('wasm-opt')

if (opt === null) {
  const notice = 'wasm-opt not found (brew install binaryen)'

  if (process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false') {
    console.error(`[build-wasm] ${notice}; the release lane must not skip it`)
    process.exit(1)
  }
  console.log(`[build-wasm] skip wasm-opt: ${notice}`)
} else {
  const version = binaryenVersion(opt)

  if (version === null || version < MIN_BINARYEN) {
    console.error(
      `[build-wasm] wasm-opt ${version ?? 'of unknown version'} is older than binaryen ${MIN_BINARYEN}, which is the first that accepts this target's features`,
    )
    process.exit(1)
  }
  /**
   * rustc 1.82+ enables these six features by default for this target, and
   * binaryen validates the input against the features it was told to allow,
   * so it rejects the module outright without all of them.
   */
  const features = [
    '--enable-bulk-memory',
    '--enable-nontrapping-float-to-int',
    '--enable-reference-types',
    '--enable-multivalue',
    '--enable-sign-ext',
    '--enable-mutable-globals',
  ]

  run(opt, ['-Oz', ...features, bundled, '-o', bundled], 'wasm-opt -Oz')
}

const after = statSync(bundled).size

console.log(`[build-wasm] ${bundled} ${before} -> ${after} bytes`)
