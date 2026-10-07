# Contributing to Kizuna

Kizuna is built in the open: every decision is recorded, and the bar for honesty in what the documentation claims is high. Contributions that hold that bar are welcome. [Contribute](./docs/resources/contribute.md) is the short path through this handbook.

## Ground rules

- Be kind. We follow the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
- Sign every commit with `git commit -s`. The flag adds a `Signed-off-by: Your Name <you@example.com>` trailer, which certifies the [Developer Certificate of Origin](https://developercertificate.org/). Kizuna asks for no CLA.
- Current JavaScript workspaces and Rust crates are Apache-2.0, except `packages/supabase-pack`, which is PolyForm Shield 1.0.0. A contribution is accepted under the same license as the file it changes, and [GOVERNANCE.md](./GOVERNANCE.md) carries the full licensing commitments.
- Never include service-role keys, real project refs, or credentials in code, docs, tests, or screenshots.

## Where contributions help most

1. Protocol review: read the [`packages/protocol/`](./packages/protocol) conformance corpus, try to break it, and open a Discussion with what you find.
2. Platform expertise: firsthand knowledge of expo-sqlite, [SQLite](https://grokipedia.com/page/SQLite) on [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) and [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API), Supabase internals, or [tus](https://tus.io/protocols/resumable-upload) resumable uploads.
3. Docs and website: clarity, typos, broken links, and comparison fairness.
4. Example apps: the [React](https://react.dev), [Vue](https://vuejs.org), [Expo](https://expo.dev), Swift, and Kotlin projects under `examples/`, plus the two-pane browser demo in `apps/demo`.

A wire-protocol change requires an RFC-labeled PR that touches `packages/protocol/` and carries a conformance-corpus update in the same PR. The [RFC process](./GOVERNANCE.md#5-rfc-process) in GOVERNANCE.md states what the RFC has to capture.

## Workspace layout

| Path | Purpose |
| ---- | ------- |
| `apps/website` | kizunasync.com: the landing page, the docs viewer, and the comparison pages |
| `apps/demo` | Two-client browser demo over the local stack |
| `apps/sync-inspector` | Read-only local sync inspector |
| `packages/core` | The app client (`createKizunaSync`), its host layer, port interfaces, and wire types |
| `packages/protocol` | Machine-readable wire spec and golden conformance corpus |
| `packages/kizunasync` | The published npm package `kizunasync`: the CLI shim, the SQL pack copy, and one entry point per public subpath over the private workspaces |
| `packages/supabase` | Supabase client integration: RPC remote, transfer, and Realtime wake-up |
| `packages/supabase-pack` | Server SQL pack and local dev stack |
| `packages/web` | Browser driver: the Rust engine as WebAssembly in a dedicated worker over OPFS |
| `packages/expo` | Expo and [React Native](https://reactnative.dev) drivers, file store, transfer adapter, and connectivity |
| `packages/react` | React bindings: seven hooks, `useKizunaSync`, `useQuery`, `useMutation`, `useSyncStatus`, `useAttachment`, `useRejections`, and `useOverwrites` |
| `packages/vue` | Vue composables |
| `packages/rn-uniffi` | React Native [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction) loader and generated [UniFFI](https://mozilla.github.io/uniffi-rs/) bridge |
| `packages/utilities` | Example-app devtools: the query log, the live-sync gate and the connectivity and wakeup wrappers it drives, the lab controls, the demo account catalog, and the todo-board predicates |
| `packages/ui` | Shared theme tokens and cross-app components |
| `examples/` | Runnable reference apps |

`core`, `supabase`, `web`, `react`, `vue`, `expo`, and `rn-uniffi` are private workspaces that apps reach only as `kizunasync` subpaths.

Apps never import from other apps, and packages never import apps or examples, so the dependency graph always points inward. [Repository layout](./docs/resources/repository-layout.md) is the reader-facing map of the same tree.

## Local setup

You need [Bun](https://bun.sh/docs/installation) `1.4.2`, the version pinned by the root `packageManager` field. You also need a [Rust toolchain](https://www.rust-lang.org/tools/install) compatible with `rust-version = 1.90`, and [Docker](https://docs.docker.com/get-started/get-docker/) for the local Supabase stack unless it runs on the stack's [native runtime](./docs/cli/local-supabase.md#1-start-the-stack) on Linux or on macOS on Apple silicon.

On Linux, building the Rust `kizunasync` CLI also needs `libdbus-1-dev` and `pkg-config` on `PATH`. On Debian or Ubuntu that is `apt install libdbus-1-dev pkg-config`.

The `keyring` crate's Secret Service backend links against `libdbus`.

Building the browser engine for the `wasm32-unknown-unknown` target also needs a clang with a [WebAssembly](https://grokipedia.com/page/WebAssembly) backend, exported as `CC_wasm32_unknown_unknown`. The build needs binaryen `116` or newer for `wasm-opt`. [CI and CD](./docs/operations/ci-cd.md#toolchain-recorded-by-the-repository) lists the platform packages. Linux also needs `CFLAGS_wasm32_unknown_unknown` set to `-std=gnu2x`. `bun run cargo:wasm` sets that by default.

```bash
git clone https://github.com/kizunasync/kizunasync
cd kizunasync
bun install
bun run build        # turbo: JavaScript workspaces and Cargo entrypoints
```

Start the local [Supabase](https://supabase.com) stack ([Postgres](https://grokipedia.com/page/PostgreSQL) + Auth + Storage + Realtime):

```bash
bun run db:start     # starts the local Supabase stack
bun run db:migrate   # applies any pending local migrations
bun run db:stop      # shut it down when done
```

The local API is available at `http://127.0.0.1:55321` once the stack is running. Use `bun run db:status` to check.

## Running the example apps

Each example is a standalone workspace. Run them from the repo root with Turbo's `--filter` flag:

```bash
# React web example
bun run --filter=@kizunasync/example-todo-react dev

# Vue web example
bun run --filter=@kizunasync/example-todo-vue dev

# Expo (React Native), which needs the Expo CLI
bun run --filter=@kizunasync/example-todo-expo start
```

## Running tests and checks

Cargo crates are Turborepo packages, through experimental Cargo workspace discovery. `bun run build` is unfiltered `turbo run build`. JavaScript packages and Cargo entrypoints (`kizunasync-napi`, `kizunasync-ffi`, `kizunasync-cli`, `kizunasync-bindgen`, `kizunasync-conformance`, host `kizunasync-wasm`) therefore share one graph. `bun run test` is unfiltered `turbo run test --ui stream`. It runs the JavaScript tests plus `cargo test --workspace --locked` without Turbo's TUI, and then the conformance binary. `bun run dev` still filters `./apps/*`, `./packages/*`, and `./examples/*`, so it does not `cargo run` those CLI binaries.

`turbo run build --filter=kizunasync-napi` builds the N-API addon. `turbo run test --filter=kizunasync-cargo` runs `cargo test --workspace --locked`. `bun run lint` and `turbo run lint --ui stream` run Clippy with `-D warnings`, `--all-targets`, and `kizunasync-ffi/http`. Nextest stays on `bun run cargo:test`.

Run `bun run test:swift` to test the Swift bindings locally, and `bun run test:todo-ios` for the native iOS example.

Each checks the on-disk `KizunaSyncFfi.xcframework` against the current Rust source before `swift test` runs. When the framework is stale, the check stops with a message naming `bun run cargo:xcframework`, so a build from an earlier Rust change never passes a green suite.

Before marking any PR ready, run the full verification gauntlet in order:

```bash
bun run test         # turbo: JavaScript tests, cargo test --workspace, then the conformance binary
bun run type-check   # turbo: TypeScript across all workspaces
bun run build        # turbo: JavaScript workspaces and Cargo entrypoints
```

If the website changed, also run its pinned build script: `bun run --filter=@kizunasync/website build`. CI runs the same checks, which [Documentation gates](./docs/operations/ci-cd.md#documentation-gates) lists gate by gate.

Bun uses the isolated linker (`bunfig.toml`); workspace binaries resolve through each workspace's own `node_modules/.bin/`. The Next apps run with `--webpack`.

## Remote build cache (optional)

CI and local development both work without it, because Turbo falls back to caching locally when no remote cache is configured.

A maintainer who wants Vercel Remote Cache for faster CI runs sets it up once. Run `turbo login` to authenticate. Run `turbo link` to connect this repository to the Vercel team. Then add `TURBO_TOKEN` (a secret) and `TURBO_TEAM` (the team slug, a plain variable) under the repository's GitHub Settings → Secrets and variables → Actions.

Once both are present, `ci.yml` and the `examples-rust` job in `rust-ci.yml` pick them up automatically on every turbo invocation.

## Making changes

1. Search the issues and Discussions first. For a protocol-shaped change, open a Discussion before writing code.
2. Branch from `develop` and keep each PR to one logical change. Every pull request runs the Linux test lanes of `ci.yml` and `rust-ci.yml`.
3. Follow [CONVENTIONS.md](./CONVENTIONS.md), which wins over any other document: no `any`, `as const` instead of `enum`, kebab-case filenames, theme tokens only, and `// MARK:` section markers.
4. Write commits short, English, lowercase, and imperative, with no body: `feat(core): hold checkpoint while outbox non-empty`, `fix(website): broken anchor in quickstart`. Always pass `git commit -s`.
5. Add a line under `[Unreleased]` in [CHANGELOG.md](./CHANGELOG.md) for every user-visible change, in the same PR and under the Keep a Changelog categories.

## Writing documentation

Kizuna docs follow the [Supabase docs style guide](https://supabase.com/docs/contributing) with the house rules in [CONVENTIONS.md](./CONVENTIONS.md#documentation-conventions). Four page types, set by the `docType` front matter:

| Type | `docType` | What it does | Ends with |
|---|---|---|---|
| Explainer | `concept` | Says what a thing is, why it exists, when to use it, and how it works at a high level. No step-by-step. | `## Related pages` |
| Tutorial | `tutorial` | Walks you to a complete result across several features, with the reason for each step. | `## Next steps` |
| Guide | `how-to` | One task, mostly procedure, background linked out. Opens with one sentence that declares the intent. | `## Next steps` |
| Reference | `reference` | Facts: parameters, returns, errors, examples. No use cases, no narrative. | `## Related reference` in the client trees, `## Related pages` elsewhere |

Before you write, collect the facts: the code path, the test that proves the behavior, and the line in [Project status](./docs/getting-started/status.md) that scopes it. Write the sentence you would say to a colleague. Put the task first and the reason second. Keep one topic per paragraph. Link the Supabase page for anything Supabase already documents (Auth, [RLS](https://grokipedia.com/page/Row-level_security), Realtime, Storage, the CLI) instead of explaining it again. Make the paragraph itself plain (no plain-terms callout).

Before you open the PR, read the page once as someone who has never used a sync engine, run `bun test` in `apps/website` (the copy lint and the docs contracts), and check that every claim matches the code you cited.

### Before and after

Before: "When newer ledger pages arrive, the pending slips are rewritten on top of them, so your edits stay on screen and other people's rows are not hidden behind them."

After: "A completed pull commits the incoming checkpoint and then replays whatever remains queued on top of it, so your unsent edits stay on screen and the rows other people changed stay visible underneath them."

Before: "A masked update can be rejected by a tombstone, RLS, a precondition, a database constraint, or HLC ordering."

After: "Every row write runs under the calling user's own policies, which Supabase documents in Row Level Security."

Before: "Permanent classifications can dead-letter after budget…"

After: "The fifth consecutive permanent failure against the same head outbox entry dead-letters that entry and the rest of its atomic batch, reverts their optimistic rows to the pre-image, and records a `DEAD_LETTER` rejection with reason `PERMANENT_TRANSPORT`."

## PR expectations

- Describe what changed and why, and link the issue or Discussion. Include screenshots for a UI change.
- A consistency claim or a comparison-page edit needs a source, linked as a research report or an external citation. An unverifiable claim does not merge, and [Consistency model](./docs/sync/consistency-model.md#what-the-model-does-not-provide) is the ceiling for what the project claims.
- Maintainers may rebase or squash to keep the history clean.

## Security

If you suspect a vulnerability in the SQL pack, the RPCs, the RLS templates, or the inspector panel, do not open a public issue. Email kizunasync@smartsquad.io with the details. We acknowledge within 72 hours and coordinate disclosure with you.

## Releases

The repository carries no Changesets configuration. A maintainer merges `develop` into `main` and pushes a `v*` tag; `release.yml` resolves the version from that tag, runs the full test suite, then calls `release-npm.yml`, `release-swift.yml`, and `release-kotlin.yml` in turn, each building and publishing under the same version, before it calls `deploy-demo.yml` and `deploy-website.yml` to deploy the public demo and the website. No other push or pull request publishes or deploys anything. Every package versions in lockstep from that one tag: it must match both root `Cargo.toml`'s `[workspace.package].version` and root `package.json`'s `version`, or the release fails before any artifact builds. Keep `[Unreleased]` in `CHANGELOG.md` accurate.
