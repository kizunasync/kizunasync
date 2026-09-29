/**
 * Run a cargo-related gate with optional skip when Rust is absent.
 * Used by `bun run cargo:*` for gates Turbo does not map (nextest, deny, doc,
 * rustdoc, conformance). Mapped Cargo tasks (`build`, `test`, `check`, `lint`,
 * `format`) go through Turbo; `bun run lint` is workspace Clippy with `-D warnings`.
 *
 * Env:
 * - KSYNC_SKIP_RUST=1: skip (exit 0)
 * - KSYNC_REQUIRE_RUST=1: fail if cargo missing
 *
 * Usage:
 *   bun scripts/cargo-gate.ts
 *     <test|conformance|build|deny|doc|rustdoc|check-gen-rust>
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { cargoToolsBin } from './lib/cargo-tools'
import { cargoOnPath, isRustRequired, isRustSkipped } from './lib/rust-env'

const root = resolve(import.meta.dir, '..')
const skip = isRustSkipped()
// Only force a missing-cargo failure when explicitly required (rust-ci sets this).
const requireRust = isRustRequired()

/** Cargo subcommands installed by `cargo install --root .cargo-tools` live here. */
const toolsBin = cargoToolsBin()

type TGate = { cmd: string; args: string[] }

const GATES = ['test', 'conformance', 'build', 'deny', 'doc', 'rustdoc', 'check-gen-rust'] as const

type TGateName = (typeof GATES)[number]

const usage = `usage: bun scripts/cargo-gate.ts <${GATES.join('|')}>`

const gate = process.argv[2] as TGateName | undefined

if (gate === undefined || !GATES.includes(gate)) {
  console.error(usage)
  process.exit(2)
}

const onPath = (bin: string, probe: string[] = ['--version']): boolean =>
  spawnSync(bin, probe, { encoding: 'utf8' }).status === 0

if (skip) {
  console.log(`[cargo-gate] skip ${gate} (KSYNC_SKIP_RUST=1)`)
  process.exit(0)
}

/**
 * Resolve a `cargo <sub>` helper: PATH first, then the repo-local install root.
 * Returns null when neither is available so the caller can fall back.
 */
const resolveCargoSubcommand = (sub: string): TGate | null => {
  if (onPath(`cargo-${sub}`, [sub, '--version'])) return { cmd: 'cargo', args: [sub] }
  const vendored = resolve(toolsBin, `cargo-${sub}`)

  if (existsSync(vendored)) return { cmd: vendored, args: [sub] }

  return null
}

const testGate = (): TGate => {
  const nextest = resolveCargoSubcommand('nextest')

  if (nextest !== null) {
    return {
      cmd: nextest.cmd,
      args: [...nextest.args, 'run', '--workspace', '--features', 'kizunasync-ffi/http'],
    }
  }
  console.log('[cargo-gate] cargo-nextest not found, falling back to cargo test')

  return { cmd: 'cargo', args: ['test', '--workspace', '--features', 'kizunasync-ffi/http'] }
}

const denyGate = (): TGate => {
  const deny = resolveCargoSubcommand('deny')

  if (deny !== null) return { cmd: deny.cmd, args: [...deny.args, 'check'] }
  // Reached only once cargo itself is confirmed on PATH (see the check below), so a missing cargo-deny is always a real gap, never the "no Rust here" skip.
  console.error(
    '[cargo-gate] cargo-deny not found on PATH or in .cargo-tools/bin, install with `cargo install cargo-deny --root .cargo-tools`',
  )
  process.exit(1)
}

const buildGate = (): TGate => {
  switch (gate) {
    case 'test':
      return testGate()
    case 'conformance':
      return { cmd: 'cargo', args: ['run', '-p', 'kizunasync-conformance'] }
    case 'build':
      return { cmd: 'cargo', args: ['build', '--workspace', '--features', 'kizunasync-ffi/http'] }
    case 'deny':
      return denyGate()
    case 'doc':
      return { cmd: 'cargo', args: ['test', '--doc', '--workspace'] }
    case 'rustdoc':
      return { cmd: 'cargo', args: ['doc', '--workspace', '--no-deps', '--locked'] }
    case 'check-gen-rust':
      return { cmd: 'bun', args: ['run', '--filter', '@kizunasync/protocol', 'check:gen-rust'] }
  }
}

/**
 * `check-gen-rust` diffs generated output via the Bun script; it needs no Rust
 * toolchain. Every other gate does.
 */
if (gate !== 'check-gen-rust' && !cargoOnPath()) {
  if (requireRust) {
    console.error(`[cargo-gate] cargo required for ${gate} but not on PATH`)
    process.exit(1)
  }
  console.log(`[cargo-gate] skip ${gate} (no cargo)`)
  process.exit(0)
}

const { cmd, args } = buildGate()

console.log(`[cargo-gate] ${cmd} ${args.join(' ')}`)
// Denies rustdoc warnings (broken intra-doc links, missing docs) only for this gate.
const env = gate === 'rustdoc' ? { ...process.env, RUSTDOCFLAGS: '-D warnings' } : process.env
const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env })

process.exit(r.status ?? 1)
