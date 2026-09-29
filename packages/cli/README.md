<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync</span>
</h1>

The npm `kizunasync` package. It resolves and runs the Rust `kizunasync` binary. Invoke it as `npx kizunasync`, `pnpm dlx kizunasync`, `yarn dlx kizunasync`, or `bunx kizunasync`.

This is a shim, not the CLI implementation. The real command surface lives in [`crates/kizunasync-cli`](../../crates/kizunasync-cli/README.md).

## What this is

The package ships the JavaScript entry point, a copied SQL pack, and this README. It does not ship the Rust executable or platform prebuilds, so a tarball alone is not an installable CLI.

Binary resolution order:

1. `KSYNC_BIN`
2. The installed `@kizunasync/cli-<triple>` platform package (optional dependency of `kizunasync`)
3. `target/release/kizunasync`, then `target/debug/kizunasync`, under a detected Kizuna workspace
4. An executable `kizunasync` on `PATH`, excluding any entry whose real path is the shim itself, such as npm's symlinked `node_modules/.bin/kizunasync`

The workspace walk starts from the shim and looks for a `Cargo.toml` that names `crates/kizunasync-cli`, unless `KIZUNASYNC_REPO_ROOT` points at the root directly. It never starts from the working directory.

The binary runs with `KSYNC_PACK_DIR` set to the `pack/` directory this package ships, unless that variable already names a directory, and with `KSYNC_SHIM_ACTIVE=1`. A shim that starts with `KSYNC_SHIM_ACTIVE=1` was started by the shim, so it exits `2` instead of starting another copy of itself.

If no binary resolves, the process exits `2` with the source-build hint. The shim inherits stdin/stdout/stderr and forwards the child exit code; SIGINT maps to `130`.

Runtime is [Node.js](https://grokipedia.com/page/Node.js) `^20.19.0 || >=22.12.0`. The monorepo builds and tests this package with its pinned [Bun](https://bun.sh) version.

## Get started

In this checkout, build the Rust binary once (see [`kizunasync-cli`](../../crates/kizunasync-cli/README.md#get-started)), then:

```sh
bun run --filter=kizunasync build
node packages/cli/dist/main.js --help
```

For product docs and package-manager invocation (`npx kizunasync`, `pnpm dlx kizunasync`, `yarn dlx kizunasync`, `bunx kizunasync`), see [CLI](../../docs/cli/cli.md). Prefer those entry points over `target/debug/kizunasync` outside this checkout's own development loop.

Source mode also resolves the workspace binary:

```sh
bun packages/cli/src/main.ts --help
```

## Command surface

The Rust parser is authoritative. Current commands:

- `init`: TTY wizard, or `--dry-run`, `--yes`, `--local-only`, `--schema`, `--project-ref` (Management API; conflicts with `--local-only`), `--db-url`, `--access-token`, `--max-batch-size`, `--require-atomic`
- `sync`: TTY table picker, or repeatable `--add` / `--remove` with per-table and push-policy flags
- `status`: text, JSON, quiet, Postgres, and Management API views
- `doctor`: local checks plus an optional Data API exposure probe
- `lint`: conservative SQL migration classifier
- `upgrade`: pack reconciliation, applying pending files only when every statement is additive, or re-applying the whole pack with `--reapply`
- `deprovision`: ledger-derived teardown, `--purge` also drops the `kizunasync` schema itself behind a typed `--confirm`
- `jobs list` / `jobs run` / `jobs schedule`: the pack's three retention jobs against `kizunasync._settings`
- `mock seed` / `mock churn`: deterministic test tooling
- `version`, plus global help / workdir / colour flags

Only bare `kizunasync`, `init`, and `sync` prompt on a TTY. Once Kizuna is installed, bare `kizunasync` opens a control panel that runs the other commands from one menu and asks before each write. `status` may format for a TTY but never prompts. `upgrade`, `deprovision`, `jobs`, and both mock commands never prompt; applied writes need `--yes` or the command-specific environment guard.

`deprovision` removes ledgered objects only. The current base pack does not ledger its schema, bookkeeping tables, indexes, or sequence, so those remain unless `--purge` drops the schema itself.

Human status goes to stderr. JSON, JSONL, quiet results, and generated statement payloads go to stdout.

## Project resolution

Global `--workdir` wins, then `SUPABASE_WORKDIR`, then the nearest ancestor with `supabase/config.toml`, then the current directory. Direct database commands resolve `--db-url`, `KSYNC_DB_URL`, `DATABASE_URL`, environment files at the resolved root, then the local config port.

## Environment variables

- `KSYNC_BIN`: an exact binary path, first in the resolution order.
- `KSYNC_PACK_DIR`: the SQL pack directory `init`, `upgrade`, and `status` read; the shim sets it to the `pack/` directory it ships unless the variable is already set.
- `KSYNC_SHIM_ACTIVE`: set on the spawned binary; a shim that finds it already set refuses to spawn another copy of itself, exit `2`.
- `KIZUNASYNC_REPO_ROOT`: overrides the workspace walk that looks for a Cargo workspace naming `crates/kizunasync-cli`.
- `KSYNC_ALLOW_DEPROVISION=1`: authorizes `deprovision` to apply, the alternative to `--yes`.
- `KSYNC_ALLOW_MOCK_SEED=1`: authorizes `mock seed` and `mock churn` to apply, the alternative to `--yes`.
- `KSYNC_DB_URL`, `DATABASE_URL`: connection-string fallbacks the Rust binary itself resolves; see [Database connection](../../docs/cli/cli.md#database-connection) for the full ladder.

## Tests

```sh
bun test
cargo test -p kizunasync-cli
```

These commands do not prove live Postgres behavior when the gated integration database is unavailable. Report skipped live tests separately.

## Related

- [CLI](../../docs/cli/cli.md): full command contract and source-only distribution
- [`kizunasync-cli`](../../crates/kizunasync-cli/README.md): Rust implementation
