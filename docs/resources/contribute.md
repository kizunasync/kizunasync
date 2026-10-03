---
title: Contribute
description: How to build, test, document, and license a change to Kizuna.
status: alpha
docType: how-to
audience: contributor
---

# Contribute

Clone the monorepo, build it, run the checks a pull request has to pass, preview a documentation change, and open the pull request. The project lives at [github.com/kizunasync/kizunasync](https://github.com/kizunasync/kizunasync), where bug reports, design discussion, and pull requests all belong. [CONTRIBUTING.md](../../CONTRIBUTING.md) is the full handbook, and this page is the short path through it.

If you are new to the project or to sync engines, or you are unsure whether a change belongs here, open a pull request or an issue anyway. Review is part of how the project learns.

## Before you begin

- Install [Bun](https://bun.sh/docs/installation) `1.4.2`, the version the root `packageManager` field pins.
- Install a [Rust toolchain](https://www.rust-lang.org/tools/install) compatible with `rust-version = 1.90`.
- Install a clang with a [WebAssembly](https://grokipedia.com/page/WebAssembly) backend to build the browser engine for the `wasm32-unknown-unknown` target, export it as `CC_wasm32_unknown_unknown`, and read the platform package names from the toolchain table in [CI and CD](../operations/ci-cd.md#toolchain-recorded-by-the-repository).
- Install [Docker](https://docs.docker.com/get-started/get-docker/), which the local Supabase stack runs on.
- Install [Git](https://git-scm.com/downloads), and on Linux add the `libdbus-1-dev` and `pkg-config` packages that the Rust `kizunasync` CLI links against.

## Licenses

Current JavaScript workspaces and Rust crates are Apache-2.0, except `packages/supabase-pack`, which is PolyForm Shield 1.0.0. Your contribution carries the same license as the file it changes. Sign off every commit with `git commit -s` under the Developer Certificate of Origin, which this project uses instead of a CLA.

[Governance](../../GOVERNANCE.md) carries the commitments behind those licenses. Drivers stay permissively licensed. No service-role key ever ships in the repository. Protocol changes go through the RFC process, and the documentation honesty rules bind what the project may claim.

## Repository layout

[Repository layout](./repository-layout.md#three-layers) is the public map of kernel, bridges, app clients, crates, and packages. Keeping that boundary intact is a review criterion, so a pull request that moves work across a layer needs to say why.

| Path | Purpose |
|---|---|
| `crates/` | Rust kernel, CLI, [N-API](https://nodejs.org/api/n-api.html), [UniFFI](https://mozilla.github.io/uniffi-rs/), [WebAssembly](https://grokipedia.com/page/WebAssembly) |
| `packages/core` | JavaScript app client, its host layer, and the ports |
| `packages/protocol` | Wire spec and golden transcripts |
| `packages/supabase-pack` | SQL pack installed into the reader's own project |
| `docs/` | Reader documentation rendered at kizunasync.com/docs |
| `examples/` | [React](https://react.dev), [Vue](https://vuejs.org), [Expo](https://expo.dev), Swift, and Kotlin reference apps |

Apps never import from other apps, and packages never import apps or examples. Host crates and packages depend on app clients rather than on engine internals they do not own.

## 1. Build and test

Clone the repository and build every workspace once:

```bash
git clone https://github.com/kizunasync/kizunasync
cd kizunasync
bun install
bun run build
```

Then run the three checks a pull request has to pass:

```bash
bun run test
bun run type-check
bun run build
```

Start the local Supabase stack with `bun run db:start` when a change touches the SQL pack or the live database tests. It runs the same [Supabase CLI](https://supabase.com/docs/guides/local-development#cli) stack the Supabase docs describe, on the ports [Local Supabase](../cli/local-supabase.md) lists.

You should now see all three commands exit zero, with `bun run test` reporting every executed corpus case as conformant. [Playground](../getting-started/playground.md) and [Quick start](../getting-started/quickstart.md) cover the example apps once the build is green.

Three rules the review bar enforces beyond those commands:

- A wire-protocol change needs an RFC-labeled pull request that updates `packages/protocol/` and the [conformance corpus](./glossary.md#conformance-corpus) in the same pull request. Never regenerate a golden transcript to make a failing test pass.
- Reader-facing `kizunasync` commands in `docs/` use `npx kizunasync`, `pnpm dlx kizunasync`, `yarn dlx kizunasync`, and `bunx kizunasync`. The Cargo debug binary is never shown as the product [CLI](../cli/cli.md).
- Consistency claims match the [Consistency model](../sync/consistency-model.md#what-the-model-does-not-provide). Do not call Kizuna a [CRDT](https://grokipedia.com/page/Conflict-free_replicated_data_type), real-time, or unqualified conflict-free.

## 2. Write and preview documentation

Reader pages live under `docs/`. The registry in `apps/website/lib/docs-registry.ts` lists the flat pages, and `apps/website/lib/reference/<library>.ts` lists the client reference trees rendered at `/docs/reference/<library>/<page>`. The website keeps no second copy of the prose.

To add a reference page, create `docs/reference/<library>/<slug>.md`, append it to that library's registry module, and keep `apps/website/lib/docs.test.ts` green. Preview your change from the repository root:

```bash
bun run --filter=@kizunasync/website dev
```

The sidebar groups are Getting started, Sync, Attachments, CLI & provisioning, Testing & operations, Reference, and Resources, and the order inside each one lives only in the registry. Documentation follows the same review bar as code, and the [Writing documentation](../../CONTRIBUTING.md#writing-documentation) section of the handbook gives the page types and the sentence-level rules.

You should now see the page at its `/docs/<slug>` route in the running dev server, with its sidebar entry in the right group, and `bun test` in `apps/website` green.

## 3. Open the pull request

Branch from `develop` and open small, focused pull requests against it. Every pull request runs the Linux test lanes of `ci.yml` and `rust-ci.yml`, which [CI and CD](../operations/ci-cd.md#workflows) lists. A good description says why the change exists rather than only what it touches, and it calls out a change to a wire format, a protocol behavior, or an operational default explicitly. For anything larger than a bug fix, such as a new app client, a protocol decision, or a change to the SQL pack shape, open an issue or a Discussion first so the design can be settled before the code arrives.

A maintainer periodically merges `develop` into `main` and pushes a `v*` tag. That tag is the only thing that releases a package: it runs the full test suite, then builds and publishes npm, Swift, and Kotlin together under the one version the tag names, so every package stays in lockstep, and then deploys the website and the public demo. [Releases](../../CONTRIBUTING.md#releases) has the full sequence.

Pull requests written with AI help are welcome on four conditions:

- Say in the description that AI was used, and which tool or model.
- Understand the change well enough to explain it in review.
- Keep the discussion human, in descriptions, comments, and review replies.
- Read the diff yourself before opening the pull request.

Follow [CONVENTIONS.md](../../CONVENTIONS.md). Commits are short, English, lowercase, and imperative, and every one of them is signed with `git commit -s`.

You should now see a pull request whose every commit carries a `Signed-off-by` trailer and whose description names the reason for the change.

## Security

If you suspect a vulnerability in the SQL pack, the RPCs, the [RLS](https://grokipedia.com/page/Row-level_security) templates, or the inspector, do not open a public issue. Email kizunasync@smartsquad.io with the details. A maintainer acknowledges within 72 hours and coordinates disclosure with you.

## Next steps

- [Repository layout](./repository-layout.md)
- [Governance](../../GOVERNANCE.md)
- [Native packaging](./native-packaging.md)
- [Protocol overview](../sync/protocol-overview.md)
- [Project status](../getting-started/status.md)
