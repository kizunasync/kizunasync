---
title: Bot / AI agent setup
description: Ordered, machine-oriented setup for coding agents. No Kizuna account exists.
status: alpha
docType: tutorial
audience: coding-agent
---

# Bot / AI agent setup

Use this page when an automated coding agent maintains the Kizuna Sync monorepo or validates engine and CLI changes. App developers start with [Quick start](./quickstart.md).

Kizuna has no product account, API token, dashboard signup, or hosted sync endpoint. The only remote account involved is the Supabase project the user already owns, reached with that project's own [API keys](https://supabase.com/docs/guides/getting-started/api-keys#publishable-keys-and-public-components).

## Before you begin

- The repository is Alpha. Every JavaScript workspace and Rust crate is version `0.2.6-alpha.3`.
- The CLI reports the workspace version `0.2.6-alpha.3` (`kizunasync --version`, read from the crate version at build time), and the SQL pack ledger records the same string as `pack_version`.
- Invoke the product [CLI](../cli/cli.md) through the user's package manager: `npx kizunasync`, `pnpm dlx kizunasync`, `yarn dlx kizunasync`, or `bunx kizunasync`. Do not tell the user to run a Cargo debug binary.
- The CLI implementation is the Rust binary in `crates/kizunasync-cli`; `packages/kizunasync` is the published npm package, with a resolver shim for that binary.
- Product topology: Rust kernel (`kizunasync-engine`), [UniFFI](https://mozilla.github.io/uniffi-rs/)/[N-API](https://nodejs.org/api/n-api.html)/[WebAssembly](https://grokipedia.com/page/WebAssembly) bridges, peer app clients (`createKizunaSync`, Swift/Kotlin `KizunaSyncClient`). Do not put `selectEngine` at the root. There is no public Rust app SDK. Read [Repository layout](../resources/repository-layout.md).
- Never place a Supabase [secret key](https://supabase.com/docs/guides/getting-started/api-keys#secret-keys-and-elevated-access) such as the service-role key in client code or a public environment variable; it bypasses [Row Level Security](https://grokipedia.com/page/Row-level_security).
- Treat database reset, [deprovisioning](../cli/removing.md), and removal commands as destructive and require the user's explicit approval.

## 1. Discover the workspace

From the repository root, verify the expected markers:

```bash
git rev-parse --show-toplevel
test -f package.json
test -f Cargo.toml
test -f CONVENTIONS.md
test -f packages/protocol/cases/manifest.json
```

Read `CONVENTIONS.md` before changing code or documentation. No root `AGENTS.md` exists; read any nested `AGENTS.md` that applies to a file you will edit.

## 2. Check tools

The JavaScript workspace pins [Bun](https://bun.sh/docs/installation) `1.4.2`. [Cargo](https://www.rust-lang.org/tools/install) is required for the CLI, N-API engine, UniFFI bindings, and Rust conformance. [Docker](https://docs.docker.com/get-started/get-docker/) is required only for [local Supabase](https://supabase.com/docs/guides/local-development) and live SQL tests.

```bash
git --version
bun --version
cargo --version
docker version
```

If Cargo is absent, `bun install` can prepare JavaScript-only work unless CI or `KSYNC_REQUIRE_RUST=1` is set. In that state, do not claim that the default Rust engine or native CLI was exercised.

## 3. Install the source checkout

```bash
bun install
```

The postinstall script attempts to build `kizunasync-napi` when Cargo exists. Verify the CLI:

:::tabs{group=pm}
```bash tab=npm
npx kizunasync --version
npx kizunasync --help
```

```bash tab=pnpm
pnpm dlx kizunasync --version
pnpm dlx kizunasync --help
```

```bash tab=yarn
yarn dlx kizunasync --version
yarn dlx kizunasync --help
```

```bash tab=bun
bunx kizunasync --version
bunx kizunasync --help
```
:::

## 4. Choose a database path

### Local Supabase

Starting the local stack is non-destructive to an unrelated project but does create containers and apply the repository's migrations:

```bash
bun run db:start
bun run db:status
```

Copy `.env.example` to `.env` and populate the printed URL, publishable key, and server-only service-role key where the template requests them. Client examples receive only the URL and publishable key.

Never run `bun run db:reset` without explicit user authorization. Stop the stack with `bun run db:stop`.

### Hosted Supabase

Use either a Supabase project ref with a Personal Access Token or a direct [Postgres](https://grokipedia.com/page/PostgreSQL) connection string. The hosted path goes through the [Management API](https://supabase.com/docs/reference/api/introduction). Do not ask for or expose a service-role key for CLI provisioning.

Plan first:

:::tabs{group=pm}
```bash tab=npm
SUPABASE_ACCESS_TOKEN=... npx kizunasync init --project-ref <your-project-ref> --dry-run
```

```bash tab=pnpm
SUPABASE_ACCESS_TOKEN=... pnpm dlx kizunasync init --project-ref <your-project-ref> --dry-run
```

```bash tab=yarn
SUPABASE_ACCESS_TOKEN=... yarn dlx kizunasync init --project-ref <your-project-ref> --dry-run
```

```bash tab=bun
SUPABASE_ACCESS_TOKEN=... bunx kizunasync init --project-ref <your-project-ref> --dry-run
```
:::

Do not remove `--dry-run` until the user has reviewed the target project, generated files, and SQL plan.

## 5. Understand what `init` writes

When the plan is applied, [`kizunasync init`](../cli/cli.md#kizunasync-init) does the following:

- It emits the installable pack migration.
- It emits a project-config migration derived from the selected tables, which upserts one `kizunasync._config` row per table plus the global `kizunasync._settings` row.
- It applies the migrations unless `--local-only` is set.

The two tables above are the configuration record, and [Configuration](../cli/configuration.md) documents every column. Kizuna writes and reads no configuration file. `init` skips a config migration already present in `supabase/migrations/` rather than emitting it twice.

Use [`kizunasync sync`](../cli/cli.md#kizunasync-sync) for later table additions/removals, [`kizunasync status`](../cli/cli.md#kizunasync-status) to inspect the ledger and the synced tables, [`kizunasync doctor`](../cli/cli.md#kizunasync-doctor) for local structure plus optional live [Data API](https://supabase.com/docs/guides/api) exposure checks, [`kizunasync lint`](../cli/cli.md#kizunasync-lint) to classify pending migration changes, and [`kizunasync upgrade`](../cli/cli.md#kizunasync-upgrade) to re-apply the shipped pack and record its hash, refusing the run when the pack carries a breaking statement.

## 6. Choose the engine lane

| Lane | Preconditions | Honest claim |
|---|---|---|
| Browser | Browser worker and the `kizunasync-wasm` build | Rust [wasm](https://grokipedia.com/page/WebAssembly) engine exercised |
| [Node](https://grokipedia.com/page/Node.js) / Bun Rust | Built N-API addon plus a driver with `databasePath` | Rust N-API engine exercised |
| React Native Rust | Linked React Native [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction) plus a `kizunasync/expo` driver, which reports `databasePath` and loads the module | Rust UniFFI engine exercised |
| No engine | No transport, no linked UniFFI handle, and no loadable addon | The app client's first engine call fails with `ENGINE_UNAVAILABLE` |
| Direct Swift / Kotlin | Generated UniFFI host package and native library | Rust UniFFI host exercised |

No environment variable selects an engine. A missing artifact must fail loud and name what is missing. [Project status](./status.md#engine-selection) states the same lanes for app developers.

## 7. Run proportional checks

Use the narrowest relevant test command for a change. Examples:

```bash
bun test packages/core
bun test packages/supabase
bun test apps/website/lib/docs.test.ts
cargo test -p kizunasync-cli
bun run cargo:conformance
```

Do not claim live SQL coverage from a test run that skipped because Postgres was unavailable. The dedicated database job starts the Supabase stack and fails if it cannot reach Postgres before the suites begin.

A green Rust conformance run reports:

```text
corpus: passed=49 failed=0 skipped_steps=1
```

Those counts come from the 50-entry corpus manifest that [Protocol evidence](./status.md#protocol-evidence) breaks down. 49 cases execute. 1 case is skipped, because the wakeup-payload decision is open. `skipped_steps` counts pull steps rather than cases. 1 of those steps sits inside one executed case, where the recorded request is not this client's own identity pull.

The live SQL replay counts a different unit, the transcript family. It pins 46 families. 45 of them replay as `PASS-SEMANTIC`, zero diverge, and 1 is `UNSUPPORTED`. That one is the held-transaction fencing race, which [Fencing and horizons](../sync/fencing-and-horizons.md) explains.

## 8. Validate an example

The repository contains five reference apps:

- `examples/todo-react`
- `examples/todo-vue`
- `examples/todo-expo`
- `examples/todo-ios`
- `examples/todo-android`

The JavaScript examples use local workspace packages. The native examples use local path dependencies on generated UniFFI packages. None proves that a public package installation works.

For a user-visible offline check, confirm a local write appears immediately, survives a restart when the driver is persistent, remains queued while offline, and drains after connectivity returns. Also exercise a server rejection and verify that the application can surface the rejection record.

## 9. Report evidence precisely

In your completion report:

- Name the exact files changed.
- Name the commands that ran, and give each exit status.
- Say whether Cargo and Docker were available.
- Say which engine lane ran.
- Say whether the database suites ran or skipped.
- Record any remaining Alpha or distribution limitation.

Do not say "Kizuna is installed" when only dependencies were installed. Say whether the source checkout, SQL pack, target project, native binding, or example app was prepared.

## Next steps

- [Quick start](./quickstart.md): the app-developer path this page defers to.
- [Repository layout](../resources/repository-layout.md): kernel, bridges, and app clients.
- [Swift: Introduction](../reference/swift/introduction.md): the native client reference.
- [Project status](./status.md): implemented, verified, and published, kept apart.
- [CLI](../cli/cli.md): every subcommand, flag, and exit code.
- [Define config](../reference/javascript/define-config.md): `defineConfig` and the per-table fields the client reads.
- [CLI configuration](../cli/configuration.md): `kizunasync._config` and `kizunasync._settings`.
- [CI and CD](../operations/ci-cd.md): which workflow proves which claim.
