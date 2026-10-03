/**
 * postinstall: build the Rust engine artifact when cargo is available.
 *
 * - Builds `kizunasync-napi` (debug) so `@kizunasync/core` can dlopen an engine without
 *   a separate cargo step after `bun i`.
 * - Skips with a one-line notice when cargo is missing (JS-only workstations).
 * - Fails hard when `KSYNC_REQUIRE_RUST=1` and cargo is missing, or when the
 *   build fails under that flag.
 * - Opt out: `KSYNC_SKIP_RUST=1 bun i`
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { cargoOnPath, isRustRequired, isRustSkipped } from './lib/rust-env'

const root = resolve(import.meta.dir, '..')
const skip = isRustSkipped()
const requireRust = isRustRequired()

const log = (msg: string) => {
  console.log(`[cargo-postinstall] ${msg}`)
}

const which = (bin: string): boolean => {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })

  return r.status === 0
}

const run = (cmd: string, args: string[]): number => {
  log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })

  return r.status ?? 1
}

if (skip) {
  log('skipped (KSYNC_SKIP_RUST=1)')
  process.exit(0)
}

if (!existsSync(resolve(root, 'Cargo.toml'))) {
  log('no Cargo.toml at repo root, nothing to do')
  process.exit(0)
}

if (!cargoOnPath() || !which('rustc')) {
  if (requireRust) {
    console.error('[cargo-postinstall] cargo/rustc required (KSYNC_REQUIRE_RUST=1) but not found on PATH')
    process.exit(1)
  }
  log('cargo/rustc not on PATH, skip Rust build (set KSYNC_REQUIRE_RUST=1 to fail)')
  process.exit(0)
}

// The addon only (full workspace build stays `bun run cargo:build`).
const status = run('cargo', ['build', '-p', 'kizunasync-napi'])

if (status !== 0) {
  if (requireRust) {
    process.exit(status)
  }
  log(`cargo build failed (exit ${status}), continuing install; fix with bun run cargo:build`)
  process.exit(0)
}

log('ok')
process.exit(0)
