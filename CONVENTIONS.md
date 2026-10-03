---
version: beta
name: Kizuna Sync Conventions
description: >-
  Canonical coding, architecture, UI, protocol, docs and git conventions for
  the Kizuna monorepo. New code must follow this file when conventions
  conflict.
audience:
  - contributor
scope:
  - monorepo
canonical: true
priority: highest
tags:
  - coding-conventions
  - typescript
  - rust
  - nextjs
  - tailwind
  - supabase
  - sync-protocol
related:
  - ./README.md
  - ./GOVERNANCE.md
  - ./CHANGELOG.md
---

# Kizuna Sync Conventions

Canonical reference for **all** conventions in this repository, the open-source offline-first sync engine for Supabase ([kizunasync.com](https://kizunasync.com)). New code MUST follow these rules. When any other doc disagrees, this file wins.

**Related documents:**

- [`README.md`](./README.md): project overview, quickstart.
- [`GOVERNANCE.md`](./GOVERNANCE.md): licensing commitments, never-paywall rules, RFC process.
- [`docs/`](./docs): the human-first getting started, sync, attachments, CLI, operations, API reference, and resources pages.

---

## Read this first

Three non-negotiable foundations. Every other rule is downstream of them.

### The protocol is the product: correctness is evidence-based and tested

The wire protocol (machine-specified in `packages/protocol/`) is the single source of truth; the golden-transcript conformance corpus in `packages/protocol/` is the **single test oracle**: the driver TCK, the testing harness, and native clients all derive from it, never fork it. Every consistency claim in docs or marketing must trace to the protocol spec or a cited source. No silent fallbacks anywhere: unsupported local queries throw typed `LOCAL_UNSUPPORTED`; permanent remote failures dead-letter only after the documented retry budget, while retryable failures stay queued; degradation modes are documented, never improvised.

### Zero data plane: nothing of ours ever touches user data

Everything server-side lives in the **customer's** Supabase project (the `kizunasync` schema SQL pack). No service of ours is in the sync path, there is no telemetry in the current clients, and **never a real service-role key**: not in code, not in docs, not in examples. Public client keys are **publishable** keys: JSON `publishable_key` / `publishableKey`, CLI `--publishable-key`, env `SUPABASE_PUBLISHABLE_KEY` (and `SUPABASE_PUBLISHABLE_KEYS` as a JSON object). `anon_key` / `--anon-key` / `SUPABASE_ANON_KEY` are accepted aliases. The Postgres role `anon` is unrelated and keeps that name. Local-development credentials printed for an individual `supabase start` stack may appear only as placeholders in `*.example` files; they are never production credentials. The CLI provisions through a direct database connection or the Supabase Management API, and the local sync inspector reads its explicitly configured local stack from the server side. A future hosted control plane must preserve this boundary. A PR that introduces an operated dependency in the data path is rejected on principle (see GOVERNANCE.md).

### Colors and spacing come from theme tokens: never hard-coded

All colors flow through semantic theme tokens, the "Sumi & Vermilion" identity (sumi-ink indigo + shu vermilion 朱). The web token definitions live in `packages/ui/src/theme.css` (`@kizunasync/ui/theme.css`), which a Tailwind app imports once from its `globals.css` (`@import '@kizunasync/ui/theme.css'`) to get the `@theme` block plus the base rules (dark `color-scheme`, the focus-visible outline, the selection colors) instead of duplicating tokens; `packages/ui/src/effects.css` (`@kizunasync/ui/effects.css`) is the plain `:root` half that file imports, and it is what a consumer without Tailwind, or one that owns its own focus rings and takes the browser default for selection, imports in its place. Use the Tailwind utilities (`bg-site-background`, `text-site-muted`, `text-site-accent`, …); **never** write a raw hex, `oklch()` or named color in a component: a new color means a new token. In rare non-Tailwind web contexts (SVG props) reference `var(--color-site-*)`. Native examples define the same semantic palette once in a local `theme.ts` and consume that object from every `StyleSheet`.

---

## Repository layout

### Naming contract

The official product name is **Kizuna Sync**; **Kizuna** is the accepted short brand name. Technical identifiers follow their layer and MUST NOT use bare `kizuna` as a generic namespace: the only permitted technical namespaces are `kizunasync`, `kizuna-sync`, and the abbreviation `ksync`/`KSYNC_`, in every language and layer (Rust crates and targets included); any new identifier carrying bare `kizuna` outside the frozen exceptions below is a naming-contract violation and is rejected on review:

| Scope | Canonical name |
| ----- | -------------- |
| Repository/root package | `kizunasync` |
| GitHub repository | `kizunasync/kizunasync` |
| npm packages | `kizunasync` (the package apps install: CLI, JavaScript entry points, React Native module) and `@kizunasync/<platform>` (the five native-binary packages it installs as optional dependencies); the private workspaces keep `@kizunasync/*` names |
| CLI package and binary | `kizunasync` (built and run from this repository) |
| Client factory, instance, types, config | `createKizunaSync`, `kizunasync`, `IKizunaSync*`, `TKizunaSync*`, `defineConfig` |
| Local SQLite internals | `_kizunasync_*` |
| Server SQL schema and RPCs | `kizunasync`, `kizunasync.pull`, `kizunasync.push` |
| Demo credentials | `@kizunasync.local`, `kizunasync-demo` |
| Repository-root environment override | `KIZUNASYNC_REPO_ROOT` |
| Database connection for the CLI | `KSYNC_DB_URL` |
| SQL pack directory override | `KSYNC_PACK_DIR` |
| Native CLI binary for the npm shim | `KSYNC_BIN` |
| npm shim recursion guard, set on the child and read by the shim | `KSYNC_SHIM_ACTIVE` |
| Destructive `deprovision` apply without `--yes` | `KSYNC_ALLOW_DEPROVISION` |
| `mock seed` and `mock churn` apply without `--yes` | `KSYNC_ALLOW_MOCK_SEED` |
| N-API addon path override | `KSYNC_NAPI_PATH` |
| Absolute path to a rendered local `kizunasync-swift` package, used to verify a release before it is published | `KIZUNASYNC_SWIFT_PACKAGE_PATH` |
| Rust workspace crates and targets | `kizunasync-*` packages (`crates/kizunasync-engine`), `kizunasync_*` lib/module targets, never bare `kizuna-*` |

Frozen brand exceptions are the lowercase wordmark, protocol annotations `kizunaStatus`/`kizunaCites`/`kizunaNote`/`kizunaOpen`, the `kizuna-todo://` deep link, migration filenames matching `NNNN_kizuna_*.sql`, and the `how-kizuna-works` documentation slug.

| Workspace   | Path             | Purpose                                                            | May import      |
| ----------- | ---------------- | ------------------------------------------------------------------ | --------------- |
| `website`   | `apps/website`   | kizunasync.com: landing, docs viewer, comparisons                 | ui              |
| `sync-inspector` | `apps/sync-inspector` | Read-only local sync inspector over the dev stack | packages       |
| `demo`      | `apps/demo`      | Two-client browser demo over the local Supabase stack              | packages        |
| `core`      | `packages/core`  | **The sync domain**: `ports/` (StoreLocator, EngineTransport, Remote, FileStore, Transfer, Wakeup), `wire/` (protocol types and the cursor codec), `host/` (scheduler, sync health, attachment queue), `query/` (the `createKizunaSync` app client), `config/`, `testing/` | nothing internal |
| `protocol`  | `packages/protocol` | Machine-readable wire spec + golden conformance corpus (the test oracle) | nothing at runtime; dev/build tooling (validator, codegen, model-checker) permitted as devDependencies |
| `kizunasync` | `packages/kizunasync` | The published npm package: the `kizunasync` CLI shim, the SQL pack copy, and one entry point per public subpath re-exporting a private workspace; `scripts/prepare-npm-release.ts` assembles the private workspaces into it | the private package workspaces |
| `supabase`  | `packages/supabase` | Supabase client integration (`createRpcRemote`, `createSupabaseTransfer`, `createRealtimeWakeup`) | core |
| `supabase-pack` | `packages/supabase-pack` | The SQL pack (`0001_kizuna_init.sql`) + local dev stack; `init` provisions it | nothing |
| `web`       | `packages/web`   | Browser driver: the Rust engine (`kizunasync-wasm`) in a dedicated worker over OPFS sahpool, IndexedDB fallback, one leader tab per database + OPFS file store + connectivity | core (peer)   |
| `expo`      | `packages/expo`  | React Native path locator (expo-sqlite / op-sqlite file name) + file store + connectivity | core (peer) |
| `rn-uniffi` | `packages/rn-uniffi` | ubrn Turbo Module over `kizunasync-ffi`. Separate from `@kizunasync/expo` so ubrn does not emit `Expo.mm`. | nothing (native glue) |
| `react`     | `packages/react` | React bindings (provider + `useQuery` / `useMutation` / `useAttachment` / `useSyncStatus`) | core, react (peer) |
| `vue`       | `packages/vue`   | Vue bindings (provide + composables)                               | core, vue (peer) |
| `utilities` | `packages/utilities` | Example-app devtools shared by the three examples: the query log, the live-sync gate and the connectivity and wakeup wrappers it drives, the lab controls, the demo account catalog, and the todo-board predicates | core           |
| `ui`        | `packages/ui`    | Shared theme tokens (`theme.css` / `palette.ts`) + cross-app components | react (peer)  |
| `examples`  | `examples/`      | Runnable reference apps (`todo-react`, `todo-vue`, `todo-expo`, `todo-ios`, `todo-android`) | JS examples: workspace packages. Native examples: in-repo Swift/Kotlin packages only, never `apps/*` |
| `kizunasync-*` crates | `crates/` | Rust kernel (`kizunasync-engine`, store, query, protocol), bridges (`kizunasync-ffi`, `kizunasync-napi`, `kizunasync-wasm`), and CLI | protocol fixtures as data only |
| scenario fixtures | `crates/kizunasync-scenarios/` | Shared binding-scenario JSON for FFI tests and the Swift and Kotlin runners. Data directory; no `Cargo.toml` | none |

`core`, `supabase`, `web`, `react`, `vue`, `expo`, and `rn-uniffi` are private workspaces that apps reach only as `kizunasync` subpaths.

`(peer)` marks two different things: on the `react`, `vue`, and `ui` rows it names a literal npm `peerDependencies` entry, confirmed in each package's `package.json`; on `core` in the `web` and `expo` rows it is an architectural note only: those drivers are designed against `@kizunasync/core`'s port SPI, while their `package.json` declares `@kizunasync/core` as a plain `workspace:*` dependency, not an npm peer declaration.

Public documentation has two distinct surfaces, with no duplicated prose:

| Surface | Audience | Rendered |
| ------- | -------- | -------- |
| `docs/` plus root `GOVERNANCE.md` | **Humans first**: getting started, sync, attachments, CLI, operations, API reference, and resources | kizunasync.com/docs |
| `packages/protocol/` | Implementers: machine-checkable spec, schemas, transcripts, and executor | Repository only; summarized by the human protocol reference and used as the test oracle |

`packages/core` owns the TypeScript app client, its host layer, ports, query API, and testing kit. The multiplatform implementation lives under `crates/`. The sync domain stays in those packages, never in apps.

- **Apps never import from other apps.** Anything reusable moves into `packages/*`.
- `packages/core` is the sync-domain app client. The multiplatform core lives under `crates/` and is the only engine `createKizunaSync` runs: on Node or Bun through the [NAPI](https://nodejs.org/api/n-api.html) addon, on React Native through the linked [UniFFI](https://mozilla.github.io/uniffi-rs/) [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction), and in the browser through the `engineTransport` the `kizunasync/web` driver carries to `kizunasync-wasm` in its own worker. `selectEngine` reads the transport first, the handle second, the addon third, and throws `ENGINE_UNAVAILABLE` naming the missing artifact when none of them resolves; a `databasePath` of `null` asks the engine for a private in-memory store. The Rust core is the only implementation of the protocol in this repository, with no environment variable and no TypeScript fallback, pinned by the shared conflict vectors in `packages/protocol/vectors/` and by the golden corpus. Engine code branches on driver capabilities, never driver names. See [Rust conventions](#rust--code-style).
- Cross-workspace imports use package names; `apps/*` local imports use the `@/` alias.
- The dependency graph points inward: apps and examples may import packages; packages never import apps or examples; `packages/protocol` imports no workspace and ships zero runtime dependencies (dev/build tooling such as the validator, codegen, and model-checker is permitted as devDependencies); `packages/core` imports neither adapters nor UI. Circular module or workspace dependencies are forbidden. When `crates/` exists, Rust crates must not import `apps/*` or example trees; they may consume protocol fixtures as data only.
- Any package's tests and dev tooling may depend on `@kizunasync/protocol` (its oracle corpus, harness, and executor) as a devDependency: per the derive-never-fork rule, everything that verifies protocol conformance derives from that single corpus; the runtime import prohibitions above are otherwise unchanged.
- Consume another workspace only through subpaths declared in its `package.json` `exports`. Deep-importing its source tree or reaching it through a relative path is forbidden.
- Native examples (`examples/todo-ios`, `examples/todo-android`) are **not** Bun/Turbo workspaces. Do not add a fake `package.json` so they appear in `turbo run`. They depend on `crates/kizunasync-ffi/bindings/{swift,kotlin}` only.
- Internal workspace dependencies use `workspace:*`. Every external runtime or development dependency is declared by the workspace that imports it; the root owns repository-wide tooling only. Never rely on implicit hoisting.
- A dependency shared by multiple workspaces uses the same version/range unless a documented platform constraint (for example Expo/React Native) requires divergence. Two such constraints hold, both on TypeScript 6 while the rest of the repository is on 7: `examples/todo-expo` follows whatever `expo install --check` expects for its SDK, and `examples/todo-vue` is blocked by `vue-tsc`, which resolves `typescript/lib/tsc`, a path missing from TypeScript 7's exports map. The Vue example keeps `typescript@~6.0.3` and runs `vue-tsc` through `scripts/vue-tsc.cjs` (Node, not Bun) so the resolved binary cannot pick root 7. Each returns to the shared range when its own tool catches up.
- Common TypeScript, formatter, linter, and build configuration lives at the root or in a dedicated config package. Workspaces extend it and declare only runtime/framework differences.

## TypeScript & code style

- **Runtime/package manager is bun**; tasks run through turbo (`bun run build`, `bun run dev`).
- The root `lint` script is `turbo run lint --ui stream`: Clippy over the Cargo workspace with `-D warnings` (and `unwrap_used` / `expect_used` / `panic`), via `experimentalTaskCommand`. It is not a JavaScript formatter or style linter. The remaining TypeScript conventions are enforced by review. Match the existing style: single quotes, no semicolons, 2-space indent, and a 120-column guide. The formatter wins when a clearer representation exceeds the guide. The root `check` script is the full gauntlet (TypeScript, `cargo check`, rustfmt `--check`, and that Clippy).
- **No `any`.** Model unknown shapes as `unknown` and narrow. Never type a function parameter as `object`, or as a union or alias that resolves to it: take a named owner contract, or `unknown` at a parse boundary. The TypeScript `object` type is not the typed object-parameter bag required below. A genuinely wrong third-party type gets a single-line commented cast, never an exported `any`.
- **Always braces** on `if`/`else`/`for`/`while`.
- **Identifier prefixes:** types `T`, interfaces `I`, enum-like `as const` objects `E` (`TVerdict`, `IStoreLocator`, `EAlertKind`). **Never TS `enum`**: `as const` object + derived union. The `TEngineError` **class** (a thrown `Error` subclass, not a type alias) keeps a `T` prefix because the conformance harness names that runtime class that way.
- Single constants `UPPER_SNAKE_CASE`; data catalogs too (`SYNCED_META_TABLES`).
- Every semantic contract has one owner. DTOs, payloads, state unions, error codes, and type guards are declared once; specializations derive from that canonical contract instead of copying fields. Types stay beside their owner. Use a `types.ts` only for a cohesive shared family, never as a repository-wide dumping ground. A regex or closed union that appears in more than one file under `packages/protocol` is imported or covered by an equality test. A number a public `docs/` page states about the corpus, the decision register, the pack inventory, or the toolchain is covered by a count test. Comments of the form "keep byte-identical" or "kept here (not imported)" are forbidden unless a test enforces the sentence.
- External data enters as `unknown` or its raw transport type and is validated at the boundary by the canonical parser/schema before reaching domain code. A type assertion never replaces runtime validation. Prefer `satisfies` for catalogs/configuration; use `as` only after a runtime proof or for unavoidable interop, never to hide an incompatibility. In production TypeScript, never chain assertions (`value as A as B`); a chain made only of `as const` is allowed. Never widen a known value to `unknown` or an open dictionary (`Record<string, …>`) in order to assert it back to a narrower type: keep inference or use `satisfies`. Never pass a value that is already a named type into a type predicate whose subject is `unknown`; call that predicate at the unparsed boundary. Test doubles may use one `as unknown as IFace` until the fake implements a narrower seam.
- Never call `Reflect.apply` or `Reflect.get` in owned TypeScript: call the function or read the property. Generated wasm-bindgen glue is exempt.
- Use `interface` for extensible object contracts and `type` for unions, tuples, mapped/conditional types, and derived types. Symbols used only as types use `import type`.
- **Every import statement is one line**, however many specifiers it carries: `import { a, b, c } from './m'`, never a brace block spread over several lines. The 120-column guide does not apply to import lines. ESLint enforces it (the project rule `kizunasync/single-line-import`, autofixable), through `bun run lint:js`, which `bun run check` includes.
- **Blank lines inside bodies follow one shape**: one blank line before a `return`, a `throw`, and every `if`, `for`, `while`, `do`, `switch`, and `try` (the blank line goes above the `//` comment that introduces the statement, so comment and statement stay together); one blank line after a run of `const`/`let`/`var` declarations before a statement of another kind; consecutive declarations touch; no blank line after a closing `}` before the next statement. ESLint enforces it (`@stylistic/padding-line-between-statements`, autofixable).
- **Documented members are set apart.** Inside an interface, a type literal, or a class body, a member that carries a `/** … */` doc block has one blank line before the block and one blank line after the member; the first member needs no blank line before it and the last needs none after it; the block itself stays attached to the member. Members without a doc block keep their spacing, so a run of undocumented one-liners stays packed. ESLint enforces it (`kizunasync/documented-member-spacing`, autofixable), and `kizunasync/doc-comment-attached` covers members too.
- `null` means a value was explicitly set to no value; `undefined` means it was never set or was not provided. Preserve that distinction across APIs. Use `??` for defaults when `0`, `false`, or an empty string remain valid values; use `||` only when every falsy value truly means absence.
- Exported functions, public methods, and callbacks that define a contract declare their return type. Local functions may rely on inference when the result is obvious.
- Pure module-scope helpers, plain named operations, and React components use function declarations. **Exception (house style):** exported **factory functions** (`createX` / `defineX`), **React hooks**, and **Vue composables** may use the `export const x = (…) => …` form: that is the established style across `packages/*` and is not a violation. Test files may additionally use `const x = (…) => …` for local fixtures and helpers: the established style across the test suites; production module-scope helpers keep the function-declaration rule. Arrow functions are otherwise for callbacks, returned factories, and local closures.
- Positional parameters are for short, unambiguous signatures. At three parameters, or whenever multiple parameters share a confusable type, use one typed object parameter. Avoid boolean mode flags; use named options or literal unions unless the boolean is itself domain data. That bag is a named type, never the TypeScript `object` type.
- **Production functions stay within shape limits**: cyclomatic complexity 10 or less, at most 80 lines (100 for `.tsx`/`.vue` components), nesting depth 3 or less, and at most 4 parameters; ESLint enforces these through `bun run lint:js`; test and harness files are exempt; the one exception is the engine transport factory, which mirrors the N-API constructor.
- Function and method names start with a verb that states their effect. Boolean names use `is`, `has`, `can`, or `should`. Avoid generic names such as `data`, `item`, `helper`, `utils`, or `common` when a precise domain name exists.
- Prefer guard clauses for invalid, empty, and terminal cases so the main path stays at the lowest indentation level.
- Use `const` by default and do not mutate caller-owned inputs. Local mutation is acceptable when confined and clearer or materially faster than copying.
- Timeout values, retry limits, protocol versions, storage keys, and other behavior-defining literals use named constants. Self-explanatory local literals may stay inline.
- **`// MARK: - <Section>` comments** organize substantial TypeScript files either in kind order (imports → types → constants → public API → internal methods → pure helpers) or as coherent feature/domain groupings: both are established practice repo-wide. Add markers only when at least two substantial sections need navigation. React component internals use Variables → Methods → Lifecycle → render → Pieces → internal. `MARK` comments never appear inside JSX or stylesheets.
- Every file has one primary responsibility visible from its name. Keep small cohesive declarations together; extract substantial helpers, adapters, or components when they can be understood and tested independently. There is no artificial one-export-per-file rule.
- Handle discriminated unions exhaustively. An impossible branch uses a shared `assertNever` helper or `satisfies never`; do not add a `default` that silently absorbs future variants.
- Start independent asynchronous work together and await it together. Sequential `await` calls require a real dependency, ordering constraint, or backpressure policy. Every Promise is awaited, returned, or explicitly marked `void` when fire-and-forget behavior is intentional and handles its own failures.
- Values caught by `catch` remain `unknown` until normalized with a type guard/helper. Public boundaries expose stable machine-readable error codes; consumers never classify errors by free text. A failure that can lose data, skip a write, or break correctness must propagate, follow an explicit retry policy, or enter an observable diagnostic/dead-letter state.
- Diagnostics are structured events with stable names and typed context. Never log secrets, [JWTs](https://grokipedia.com/page/JSON_Web_Token), [Supabase](https://supabase.com) keys, credentials, complete user payloads, or unnecessary PII; record only minimal, redacted identifiers.
- JSDoc documents non-obvious invariants, effects, error behavior, units, and compatibility. It does not paraphrase a clear name or type.
- Comments are terse and explain only a non-obvious _why_. **Never put a comment inside a template or a style file.** No JSX/TSX comments (`{/* … */}`), no HTML comments (`<!-- … -->`), nothing inside `.vue`/`.svelte`/`.astro` template markup, CSS/SCSS, or `<style>` blocks: enforced by review. Replace structural narration with a named component, semantic class, token, or function. The only exceptions are mandatory license/vendor notices and an unavoidable platform workaround that cannot be made self-explanatory; isolate either in its own file.
- **Comment form follows position.** A comment that documents a declaration (function, class, component, type, interface, enum, constant, method, property) or a file preamble or a group note uses the block form `/** … */`: one opening `/**`, a leading ` * ` on every continuation line, a closing ` */`, never stacked `//` lines. Inside a function or method body every comment is one `//` line, however long, never wrapped and never a block; it sits directly above the statement it explains. `// MARK: - <Section>` markers are always one line (a multi-line rationale goes in a `/** … */` block above the marker). **Placement is part of the rule**: a block that documents the declaration that follows (function, class, component, type, interface, enum, constant) sits directly above it with no blank line in between, so tooling and readers attach it to that declaration; a block that describes the file as a whole is the first thing in the file, above the imports (in a `.vue` file, first inside `<script setup>`; after a `'use client'` directive when one exists), and a file has at most one such preamble; a block that describes a group of declarations sits above that group's `// MARK: - <Section>` marker. A block followed by a blank line and then a declaration is a defect; the project ESLint rule `kizunasync/doc-comment-attached` fails on that shape.
- No diagnostic `console.log` in committed application or library code. Intentional CLI stdout is part of the command contract and is allowed; diagnostics use explicit error/reporting paths.

## Rust & code style

Applies to every crate under `crates/` (and any future Rust binary/library in this monorepo). **Authoritative external sources** (in this order when they conflict with blog posts or social tips):

1. [The Rust Style Guide](https://doc.rust-lang.org/nightly/style-guide/): formalized via the style RFC process; default style for `rustfmt` ([RFC 2436](https://rust-lang.github.io/rfcs/2436-style-guide.html), style evolution [RFC 3338](https://rust-lang.github.io/rfcs/3338-style-evolution.md)).
2. [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/): library-team recommendations for public API design (`C-*` checklist).
3. [RFC 430](https://rust-lang.github.io/rfcs/0430-finalizing-naming-conventions.html): naming / casing conventions.
4. [Clippy](https://doc.rust-lang.org/clippy/) + [rustc lint groups](https://doc.rust-lang.org/rustc/lints/groups.html): automated smell detection.
5. [The Rust Reference](https://doc.rust-lang.org/reference/) and [The Rustonomicon](https://doc.rust-lang.org/nomicon/): language rules and `unsafe` contracts (not style blogs).

House rules below **narrow** those sources for Kizuna (never a rival style guide).

### Toolchain and CI gates

- **Edition:** Rust 2024 when the workspace toolchain supports it; otherwise the latest stable edition pinned in `rust-toolchain.toml`. One edition for the whole workspace.
- **Formatter:** `cargo fmt` with **default** rustfmt style (no personal `rustfmt.toml` churn). Formatter wins on layout.
- **Lints (deny in CI for library crates):**
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - Group baseline: `clippy::all`, plus `clippy::cargo` where applicable.
  - Prefer `clippy::pedantic` as **warn** with explicit, justified `#[expect(clippy::…)]` at the smallest scope, so a lint that stops firing is reported; use `#[allow]` only where the lint does not fire in every build or target (test-module `unwrap_used`/`expect_used`/`panic` groups, `cfg`-gated items). Do not disable the whole group silently.
  - Deny: `clippy::unwrap_used` and `clippy::expect_used` in **library** code (`kizunasync-engine`, `kizunasync-protocol`, …). `unwrap`/`expect` are allowed in tests, examples, and binaries only with a comment that states the invariant.
  - Deny: `clippy::panic` in library code on reachable paths; panics are for programming bugs, not protocol/user errors.
- **Unsafe:** forbidden in application logic by default. Any `unsafe` block requires (1) a `// SAFETY:` comment naming the invariant, (2) confinement to a small module (e.g. [FFI](https://grokipedia.com/page/Foreign_function_interface) glue), (3) review. Prefer safe wrappers over re-exporting raw pointers.
- **Deps:** minimize. Every new crate dependency needs a one-line justification in the PR. Prefer `std` and existing workspace crates. No `unwrap`-heavy “convenience” crates in the engine path.
- **Features:** use Cargo features for optional surfaces (`attachments`, `napi`, …). Default features stay lean for mobile embedders.

### Naming (RFC 430 + API Guidelines C-CASE)

| Item | Convention |
| --- | --- |
| Crates | `kizunasync-*` prefix for workspace crates (hyphenated package names, `kizunasync_*` lib targets), bare `kizuna-*` is forbidden by the Naming contract |
| Modules / files | `snake_case.rs` |
| Types, traits, enums, enum variants | `UpperCamelCase` |
| Functions, methods, modules, local bindings | `snake_case` |
| Static / const | `SCREAMING_SNAKE_CASE` |
| Type parameters | short `UpperCamelCase` (`T`, `E`, or descriptive `Row`) |
| Lifetimes | short `'a`, or descriptive `'engine` when it helps |

- Prefer full words over abbreviations in public APIs (`transaction` not `txn` unless already a domain term).
- Trait names are nouns or adjectives (`SqlDriver`, `Readable`); avoid `I`/`T`/`E` TypeScript prefixes in Rust: idiomatic Rust does not use them.
- Conversion methods follow API Guidelines: `as_`, `to_`, `into_` with the documented cost conventions (C-CONV).
- Constructor-like functions: `new`, `with_config`, `try_from` / `from` when implementing those traits.
- Fallible constructors and parsers return `Result` (`C-NEWTYPE`, fail early).

### Types, errors, and API shape (API Guidelines)

- **Make illegal states unrepresentable** (C-STRUCT): newtypes for protocol IDs, cursor tokens, table names when free `String` would accept garbage at the boundary.
- Public errors are structured: a crate-level `Error` enum (thiserror or equivalent) with **stable discriminants** that map to the engine’s machine-readable codes (parity with `EEngineErrorCode` / wire reasons). Do not force callers to parse English messages (aligns with TypeScript “no free-text classification”).
- Prefer `Result<T, E>` over panicking for anything that can arise from peer input, disk, or network.
- Prefer borrowing (`&str`, slices) at hot boundaries; own (`String`, `Vec`) at storage and FFI edges when lifetimes would infect the whole API.
- Do not expose `Rc`/`RefCell`/`Mutex` in public signatures unless the type *is* the concurrency boundary; document thread-safety (`Send`/`Sync`) for public types (C-SEND-SYNC).
- Sealed traits when implementors must stay in-crate (C-SEALED).
- `#[non_exhaustive]` on public enums/structs that may grow (C-STRUCT-PRIVATE / evolution).
- Document panic conditions, errors, and safety with rustdoc (`///`, `# Errors`, `# Panics`, `# Safety`), same bar as JSDoc for non-obvious contracts.
- No `println!` / `dbg!` in library code. Use structured `tracing` if logging is required; never log secrets, JWTs, or full user payloads (same rule as TypeScript diagnostics).

### Control flow and structure

- Prefer early `return` / `?` over deep nesting (same spirit as TypeScript guard clauses).
- Exhaustive `match` on closed protocol enums; never a silent `_ =>` that drops a new wire variant. Use `#[deny(unreachable_patterns)]` intent: adding a variant must break the build until handled.
- Iterator adapters and clear ownership beats index soup; micro-optimize only with evidence.
- Modules map to domains (`local_store`, `pull`, `push`, `query`), not to layer-of-the-week folders. `lib.rs` re-exports the public surface only.
- File size: Clippy's pedantic `too_many_lines` fails any function over 100 lines of code, since `bun run check` runs Clippy with `-D warnings`; aim for 80, and split when a unit is independently testable.
- Comments explain non-obvious **why** (safety, protocol invariants, FFI). Do not narrate the borrow checker. Multi-line comments use `//` consecutive lines or `///` / `//!` for docs; rustdoc for public items is mandatory for exported API.

### FFI and multi-language surfaces

- UniFFI / NAPI / C ABI crates are **thin**: no business logic, only type mapping and error translation.
- Generated bindings (Swift, Kotlin, TS types from UniFFI) are **never hand-edited**; regenerate from the Rust source of truth (`bun run cargo:bindgen`).
- Swift/Kotlin sources stay **in this monorepo** (`crates/kizunasync-ffi/bindings/`). `bun run cargo:xcframework` / `bun run cargo:aar` build the [XCFramework](https://developer.apple.com/documentation/xcode/creating-a-multi-platform-binary-framework-bundle) and the two Android AARs locally and in CI; releases publish them through `release-swift.yml` (XCFramework on the GitHub Release plus the `kizunasync/kizunasync-swift` package) and `release-kotlin.yml` (`com.kizunasync:kizunasync` and the `com.kizunasync:kizunasync-engine` it depends on, both on Maven Central). Android configuration uses [Gradle](https://gradle.org) wrapper 8.7 with AGP 8.6.1. Namespaces are `KizunaSync` / `com.kizunasync.kizunasync`, never bare `kizuna`. Live HTTP is the `http` Cargo feature on `kizunasync-ffi`; those packaging scripts enable it. Default features stay lean.
- Public error codes crossing FFI stay stable string/int discriminants agreed with the TypeScript surface.
- Async: the Kizuna **engine** crate may depend on **Tokio** with a minimal feature set (application-style network engine). Do not expose Tokio types across UniFFI/NAPI public surfaces. Pure helper crates (codecs, pure query eval without I/O) stay free of a runtime when practical.

### Tests (crate-local)

- Unit tests live in the same file (`#[cfg(test)] mod tests`) or next to the module as `foo/tests.rs` when large.
- Integration tests for a crate live in that crate’s `tests/` directory.
- Prefer deterministic tests: inject clocks/IDs (the same rule the conformance harness follows). No wall-clock flakiness.
- Property / proptest tests are welcome for codecs and pure evaluators; golden corpus tests remain the wire oracle (see the protocol oracle).

### What we deliberately do not follow

- Unofficial “Rust style” listicles, influencer repos, or corporate guides that contradict rustfmt defaults or the API Guidelines without a Kizuna-specific reason written in the PR.
- Clippy nursery/restriction groups as a blanket deny (too noisy); cherry-pick individual lints when useful.
- Premature `async` everywhere or premature `unsafe` for speed.

## File naming

- **Everything kebab-case** (`site-header.tsx`, `use-scroll-progress.ts`); exported components PascalCase; hooks prefixed `use-`; [Vue](https://vuejs.org) single-file components use PascalCase filenames (`TodoView.vue`, `EditTodoModal.vue`), ratifying established practice in `examples/todo-vue/src/`. Swift and Kotlin follow their language defaults (PascalCase types, `com.kizunasync.kizunasync` packages); kebab-case is a TypeScript/JavaScript rule.
- Tests colocated as `<name>.test.ts`.
- Repo docs `UPPERCASE.md` at root; design docs `UPPERCASE.md` under `docs/`; a package may carry its own `UPPERCASE.md` at its package root for a package-defining document (precedent: `packages/protocol/PROTOCOL.md`).
- [Next.js](https://nextjs.org) and Expo Router reserved files (e.g. `_layout.tsx`) keep framework names; parenthesized route-group directories (e.g. `(tabs)/`) keep theirs too.
- Generated files identify their generator and are never edited, reformatted, or patched manually. Change the source schema/template/script and regenerate reproducibly.
- Every `index.ts` is a pure barrel. It contains comments plus inline re-exports only, with one single-line statement per source module: `export { createX, type IXOptions } from './x'`. `export *` is allowed, and barrel lines may exceed 120 columns. Imports, implementations, local declarations, and import-then-export patterns are forbidden.
- Code inside a package imports its owning module directly, never the package's own barrel. Barrels define public boundaries; they are not internal dependency shortcuts.

## UI rules: `apps/website` and `apps/sync-inspector`

- React 19 function components; `'use client'` only where interaction demands it: server components are the default. All content lands **in the server-rendered HTML** (JSON-LD, meta, copy); progressive enhancement always: motion animates _from_ a visible SSR state, never gates visibility behind JS.
- Component props stay inline by default and are destructured in the function signature. Name a props type only when another declaration imports or reuses it; retain a `props` object only when it must be forwarded, compared, or accessed dynamically.
- In JSX, use `&&` rendering only with an already-boolean condition; use a ternary or explicit boolean comparison when `0`, strings, or other falsy values could render.
- Do not add `useMemo`, `useCallback`, or `memo` by default. Manual memoization requires a referential-identity contract, a dependency requirement, or measured cost.
- `useEffect` synchronizes an external system. Do not use it to derive state from props, transform data, or react to an event that belongs in the event handler.
- The website uses native elements plus Tailwind. `apps/sync-inspector` uses HeroUI 3 with React Aria semantics (`onPress`, not `onClick`).
- `<details>`/`<summary>` accordions put padding on the `<summary>`; hide the native marker.
- Page gutter is the `site-container` utility. Decorative layers (`.bg-grid-faint`, the 絆 watermark) live on their own absolutely-positioned `aria-hidden` elements.
- Motion is CSS-first (`Reveal`, `RevealOnScroll`, `StatCounter`, terminal replay) with one IntersectionObserver per section; **always honor `prefers-reduced-motion`** (handled centrally in `globals.css`).
- External links: `target="_blank"` + `rel="noopener noreferrer"`. Decorative glyphs get `aria-hidden="true"`.
- Docs published on the site come from the Markdown paths declared in `apps/website/lib/docs-registry.ts`: reader pages under `docs/` plus root `GOVERNANCE.md`. The website never duplicates their prose.

## UI composition and reuse

- Maximize **meaningful** reuse, not abstraction count. Repeated visual or behavioral semantics become one component; coincidentally similar markup may remain local until the contract is clear.
- Reusable presentation components are domain-agnostic: they receive data, labels, render slots, events, and accessibility text through typed props. They never import Supabase clients, protocol state, route modules, environment variables, or app-specific copy.
- Keep data access and business rules in `lib/`, server functions, or domain packages. Components render already-classified states and emit intent; they do not discover infrastructure.
- Extract within the owning app first. Promote to `packages/ui` when the same stable semantic primitive is used by at least two apps, or when it is an intentional design-system primitive. Do not publish speculative one-use wrappers.
- Prefer composition and slots over boolean-heavy components. A component with unrelated modes, app-specific branches, or a growing matrix of flags must be split.
- Tables, panel shells, status/empty/error states, page headers, filters, and pagination must use shared primitives inside the app instead of duplicating structural markup.
- Duplication is a review signal: the third occurrence must be extracted or accompanied by a short explanation of why the contracts differ.

## Sync inspector: `apps/sync-inspector`

- The sync inspector is the OSS operational panel and uses **HeroUI v3 OSS** with React Aria semantics. Do not copy HeroUI Pro template source into this Apache-2.0 repository.
- Follow a Supabase-Studio-like information hierarchy: persistent shell/navigation, concise page header, operational status first, dense readable tables, and details on demand. Clarity beats decorative dashboard chrome.
- Route files compose pages and start independent server reads in parallel. Query definitions, row types, and error classification live under `lib/`; reusable rendering lives under `components/`.
- Server Components are the default. Add `'use client'` only to the smallest interactive leaf. Service-role or privileged clients stay server-only and never cross a component prop boundary.
- HeroUI interactions use `onPress`, not `onClick`. Native semantic HTML remains valid inside HeroUI surfaces when it is simpler or safer for server rendering.
- Every data panel uses the shared panel, state-boundary, and table primitives. Loading, empty, unreachable, not-exposed, and error states must be deliberate and accessible.
- Inspector-specific reusable components stay in `apps/sync-inspector/components`; only cross-app design-system primitives graduate to `packages/ui`.

## Protocol & SQL rules

- Wire-protocol changes require an RFC-labeled PR to `packages/protocol/` (GOVERNANCE.md section 5) and a conformance-corpus update in the same PR.
- The SQL pack is **plain, readable [Postgres](https://grokipedia.com/page/PostgreSQL)**. `_provisions` records the objects that `kizunasync deprovision` may remove; the base schema, bookkeeping tables, sequence, indexes, and other deliberately persistent pack objects are not represented as a promise of full teardown. Triggers on vendor-managed schemas (`storage.objects`) stay read-only accelerators with an RPC contract fallback.
- Consistency vocabulary in docs and site must match the guarantees and explicit non-guarantees in `docs/sync/consistency-model.md`, backed by the current conformance corpus. Never say "real-time", "CRDT", "serializable", "crash-safe", or unqualified "conflict-free" without a test artifact that proves that exact claim.
- Honesty is brand identity: the fit/non-fit list in [`docs/getting-started/introduction.md`](./docs/getting-started/introduction.md) and the comparison pages name competitors **including when to choose them**. Marketing copy that hides a limitation is a bug.


## Documentation conventions

How `docs/` is structured and written:

**Markdown is never hard-wrapped.** This applies to EVERY `.md` in the repository (this file, `README.md`, `CHANGELOG.md`, `docs/`, package READMEs, all of it). Each paragraph and each list item is ONE full-length line; rely on the editor's soft-wrap. Do not insert mid-paragraph line breaks at any column. The 120-column guide in the TypeScript & code style section governs CODE only, never markdown prose. Real structural boundaries are kept: blank lines between blocks, one line per list item, headings, table rows, fenced code blocks, and YAML front matter.

### Structure

- **Taxonomy:** the site registry exposes seven product-area groups in this order: *Getting started*, *Sync*, *Attachments*, *CLI & provisioning*, *Testing & operations*, *Reference*, *Resources*. Optional `subgroup` values nest sidebar sections (Frameworks, Guides, Concepts, Client libraries). A page lives in the folder named for its group: `docs/getting-started/`, `docs/sync/`, `docs/attachments/`, `docs/cli/`, `docs/operations/`, `docs/reference/`, `docs/resources/`. Root `GOVERNANCE.md` is registered under Resources.
- **Files kebab-case, no numbered prefixes**: ordering lives ONLY in the website registry modules, `apps/website/lib/docs-registry.ts` for flat pages and `apps/website/lib/reference/<library>.ts` for client reference trees. Physical folders follow the same names: `docs/getting-started/`, `docs/sync/`, `docs/attachments/`, `docs/cli/`, `docs/operations/`, `docs/reference/`, `docs/resources/`. The display label is set in the registry. Set `navHidden: true` to omit a page from sidebar, mobile nav, prev/next, and docs hub while keeping `/docs/<slug>` and raw agent routes live (`agent-setup` uses this).
- Client reference trees live at `docs/reference/<library>/<slug>.md`, rendered at `/docs/reference/<library>/<slug>`; the first three pages are always Introduction, Installing, Initializing; sections come from `REFERENCE_SECTIONS` and appear in that global order; Swift and Kotlin trees are identical and share `SHARED_REFERENCE_SLUGS` with JavaScript so the language switcher keeps the page; the flat API reference group keeps SQL pack, Protocol reference, and Status taxonomy.
- The Getting-started index gives a **numbered reading order** across articles: Introduction → Quick start → Playground.
- Reference is versioned per release; guides/concepts stay evergreen. Each versioned reference index doubles as release notes. Every reference tree shows the current workspace version and its public coordinate (npm `kizunasync`, Swift package `kizunasync/kizunasync-swift`, Maven `com.kizunasync:kizunasync`) on Introduction and in the page eyebrow.

### Article anatomy

- **H1 equals the sidebar** for flat docs. The YAML `title`, the markdown `#` heading, and `docs-registry.ts` `title` are the same string. Do not prefix how-tos with “Use Kizuna with…” or suffix references with “reference”; the lede states the task. Root `GOVERNANCE.md` uses the sidebar label `Governance`. **Exception (client reference trees only):** YAML `title` is the sidebar label; H1 is `<Library>: <title>` (for example `# Swift: Insert data`). Frontmatter also carries `library` and `pageKind` (`introduction` | `installing` | `initializing` | `method` | `guide` | `type`).
- **Client reference method and initializing pages:** `## Examples` is the first H2 and holds at least one fenced block in the library language; allowed H2s in order are `Examples`, `Parameters`, `Returns`, `Errors`, `Notes`, `Related reference` (all optional except `Examples` and `Related reference`). An `initializing` page also carries `Next steps`, between `Notes` and `Related reference`; a method page never carries it. Titles are task phrases (`Insert data`, `Set bucket`); hooks and composables keep their identifier (`useQuery`). Parameter tables use the header `| Name | Type | Required | Description |`. Never leave a placeholder Parameters row such as `see example`. Code blocks follow the file-label rule below. Relative links between reference pages resolve from the source file. Shared-slug pages in Swift, Kotlin, and JavaScript link their twins under `## Related reference`. The example domain is the `todos` table (`user_id`, `image_path`, sample title `"works on a plane"`).
- **Client reference two modes.** (1) *Supabase-shaped* APIs (local `from().select/insert/update/delete` and the filter chain where they mirror supabase-js): document our call signature in Parameters; link the matching Supabase reference URL; in `## Notes` state what is identical and the local-first deltas (immediate local apply, outbox, later push/pull, [RLS](https://grokipedia.com/page/Row-level_security) enforced on push, reads from local [SQLite](https://grokipedia.com/page/SQLite) only); link [Offline writes](./docs/sync/offline-writes.md) and [How Kizuna works](./docs/getting-started/how-kizuna-works.md). Do not re-document Auth, RLS policy authoring, Realtime channels, or Storage buckets. (2) *Full Kizuna* APIs (sync controls, buckets, rejections, attachments, `defineConfig`, adapters, drivers, hooks/composables, native `apply`/`query`/`applyWhere`, host scheduler): document Parameters, Returns, Errors, and Notes completely from source; invent nothing. A method with no arguments uses one Parameters row whose Name is `(none)`.
- **Client reference introduction pages** carry only `## Version`, `## What this reference covers`, `## What Supabase covers`, `## Related reference`. The version line matches the registry `versionSource` and always ends with a link to Installing. Never re-explain sign-in, sessions, RLS, Realtime channels, or Storage buckets: link the matching Supabase reference page in the deferral table.
- **Client reference installing pages** show the public registry coordinates: npm `kizunasync` through `:::tabs{group=pm}` (`npm install`, `pnpm add`, `yarn add`, `bun add`), the Swift package `https://github.com/kizunasync/kizunasync-swift` (product `KizunaSync`), and Maven Central `com.kizunasync:kizunasync`. Never show `workspace:*`, `.package(path:)`, Gradle path modules, or `crates/…` paths on app-developer pages; checkout lanes belong to contributor docs (`contribute.md`, `native-packaging.md`, `playground.md`, example READMEs).
- **No "Introduction" heading**: 1–3 plain sentences directly under the title saying what this is and what the page covers. The product Introduction page then uses **Vision**, **Features**, and **Use cases** (including an explicit non-fit). Quick start is `kizunasync` in the reader's Supabase app project (verify CLI → interactive `kizunasync init` → doctor/status); scripted flags belong in Install, not step one. Playground is the hosted demo plus in-repository examples. Contribute is the monorepo maintainer path. Product pages state the forward path only, no defensive "do not clone" copy.
- **`docType` is one of** `tutorial`, `how-to`, `concept`, `reference`. Tutorials are the happy-path sequence; how-tos are a single task; concepts explain a mechanism; reference is lookup. A page that mixes roles gets split.
- How-tos get **`## Before you begin`** immediately after the lede (bulleted, linked). A bullet that names a tool the reader must install links the official install page: [Bun](https://bun.sh/docs/installation), [Docker](https://docs.docker.com/get-started/get-docker/), [Rust](https://www.rust-lang.org/tools/install), [Git](https://git-scm.com/downloads).
- Steps are numbered and each ends in a **verifiable state** ("you should now see…").
- Code samples are **copy-paste complete**, with the file labels below and lowercase SQL; never elide setup the reader needs.
- **File labels:** every fenced `ts`, `tsx`, `js`, `jsx`, `vue`, `swift`, `kotlin`, and `sql` block starts with a comment that names the file in the reader's project where that code lives (`// src/kizunasync.ts`, `<!-- src/components/TodoImage.vue -->`, `-- supabase/migrations/<timestamp>_<name>.sql`). A method example is an excerpt of that file with its imports, and its label may say so with `(excerpt)`. A TypeScript block that is the script of a Vue component names that component file followed by `(script setup)`. A block that shows a published type names its import path instead (`// kizunasync`), and a SQL query the reader runs by hand is labelled `-- Supabase SQL editor or psql`. `bash`, `sh`, `text`, `mermaid`, and `json` blocks carry no label; the sentence before a JSON block names its file. `apps/website/lib/code-block-paths.test.ts` enforces the rule across `docs/`, `README.md`, and the package READMEs.
- Labels reuse the paths the guides use, so a file keeps one name on every page: `src/kizunasync.ts` for the app client, `src/supabase-client.ts` for the Supabase client, `src/main.tsx` for a React root, `src/main.ts` for a Vue or vanilla entry, `src/app/_layout.tsx` for the Expo Router root layout, `src/components/<kebab-case>.tsx` for a React or React Native component, `src/components/<PascalCase>.vue` for a Vue component (`src/App.vue` holds root-component content only), and `supabase/migrations/<timestamp>_<name>.sql` for a migration. Swift and Kotlin blocks use the files [Swift and Kotlin](./docs/getting-started/native-clients.md) creates: `TodoApp/Supabase.swift`, `TodoApp/TodoSync.swift`, `TodoApp/TodoApp.swift`, and `TodoApp/TodoListView.swift` on iOS, and `Supabase.kt`, `TodoSync.kt`, `MainActivity.kt`, and `TodoScreen.kt` under `app/src/main/kotlin/com/example/todo/` on Android.
- Shared how-to framework tabs are **React**, **Vue**, **Expo/React Native**, **Swift**, **Kotlin**, and **Vanilla / other**. Quote labels that contain spaces (`tab="Expo/React Native"`). Runtime API snippets shared by the language clients (for example `setBucket`, transforms, event listeners) use the separate persistence group `:::tabs{group=lang}` with labels drawn from **TypeScript**, **Swift**, and **Kotlin** (a page presents only the languages it covers), so a language choice never collides with the framework-tab choice. Dedicated JavaScript bindings are `kizunasync/react` and `kizunasync/vue` only; Swift and Kotlin use `KizunaSyncClient` over UniFFI (`create`, `apply` with optional `transforms` / `precondition`, `applyWhere`, `query`, `from`, `inspect`, `dispose`, `sync`, `pullOnce`, `pushOnce`, `outboxDepth`, `setAccessToken`, `setBucket`, `rejections`, `dismissRejection`, `reset`, `checkpoint`, `seedCheckpoint`, `on`, `fromFile`, `resolveDownload`, `vacuum`, `getStatus`, `watch`). Host `KizunaSyncScheduler` refreshes the session JWT then calls `sync()` on path and foreground, and publishes `health()` / `onHealth`. Do not invent native `useQuery` / `useAttachment` / `useRejections` / `useSyncStatus` APIs: those hooks are JavaScript-only; native apps combine `on` with Combine or Flow. Every other JavaScript UI uses the core client. Do not invent `kizunasync/svelte` (or equivalent) tabs.
- The public structure page is [`docs/resources/repository-layout.md`](./docs/resources/repository-layout.md): kernel (`kizunasync-engine`), bridges (`kizunasync-ffi`, `kizunasync-napi`, `kizunasync-wasm`), peer app clients (`createKizunaSync`, Swift/Kotlin `KizunaSyncClient`). Do not put `createKizunaSync` or `selectEngine` at the root of product diagrams. There is no public Rust app SDK. Vite how-tos stay JavaScript-only and must state that the browser runs the Rust engine inside the `kizunasync/web` worker as [WebAssembly](https://grokipedia.com/page/WebAssembly), over the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) sahpool VFS with the relaxed [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) fallback, with one leader tab per database and the rest proxied to it, and that it needs no COOP or COEP headers and no `SharedArrayBuffer`.
- Marketing hero `FRAMEWORKS` are [Expo](https://expo.dev), [React Native](https://reactnative.dev), [React](https://react.dev), Vue, Swift, Kotlin. Do not add Next.js / Ionic / Svelte (no first-party binding) or a "Rust" app-framework glyph (Rust is the kernel).
- Callouts stay sparse, never stacked; they render as plain markdown blockquotes (no admonition component exists), so the danger/caution/tip/note vocabulary (danger = data loss/leak · caution = bug risk · tip = optional improvement · note = everything else) is editorial guidance for authors, not a distinct rendered style.
- Every page must remain readable by a developer who has never used a sync engine, in the page's own sentences. When a paragraph needs a picture in words, one plain sentence inside the paragraph does it, once, and it never adds or strengthens a guarantee the technical text does not state; there is no plain-terms callout and no fixed metaphor palette.
- Future work is described in detail in `docs/resources/roadmap.md` only. Any other page that mentions a planned feature gives at most one sentence plus a link to the specific roadmap heading; it never restates the plan.
- End with a hand-off whose heading is fixed by group and `docType`: Getting started pages and every `tutorial` or `how-to` page use **`## Next steps`**; Reference group pages use **`## Related reference`**, and a client reference `initializing` page carries **`## Next steps`** followed by **`## Related reference`**; every other page uses **`## Related pages`**.
- Unshipped features carry an explicit **Status: planned** line and must not name a release as though its contents were already fixed. A release target belongs in the roadmap, not in a runnable guide or current reference.

### Style (lintable)

Write like you talk: the sentence you would say to a colleague, not the one you would put in a whitepaper. Second person ("you" is the reader; "we" is the Kizuna maintainers only) (a reference entry describes the API in the third person, as in "`sync()` pushes the outbox", and addresses the reader only in Examples and Notes) · present tense · active voice · one relationship per sentence · one topic per paragraph, and a new paragraph whenever the topic changes · the task or the fact first, the reason second · sentence-case headings that are nouns or task phrases, never questions · code samples complete and copyable, labelled under the file-label rule in Article anatomy, with lowercase SQL and the `todos` example domain · descriptive link text, never "here" · tables for lookup, prose for reasoning; a bullet list has at least two items written as full sentences · bold only for UI labels, italics only for a term on first definition, code font for anything typed or copied · admonitions only for danger (data loss or leak) and caution (bug risk), and their first sentence says why it matters · Oxford comma, American English · no em dash in prose (`—` only as an empty table cell; `<title>` separators use ` · `) · banned filler: *just, simply, easy, easily, please, let's, actually, obviously* · banned AI lexicon: delve, tapestry, leverage, robust, seamless, groundbreaking, cutting-edge, pivotal, multifaceted, foster, harness as a verb, unlock, unleash, testament, furthermore, moreover, additionally, "it's important to note", "in today's fast-paced world", "at the end of the day", "not only … but", "it's not just", "isn't just", thrilled, game-changer, revolutionize, best-in-class, "to be honest", crucial, vital, showcase, underscore as a verb, "serves as", "stands as", boasts, "deep dive", "it's worth noting", "in this guide we", "let's dive", "at its core", "in essence", "in summary", "to summarize", "in conclusion", "overall,", "whether you're", streamline, empower, "navigate the", landscape, journey, game-changing, powerful, effortless, plethora, myriad (`apps/website/lib/copy.test.ts` enforces all of these across public pages and documentation; identifiers such as CSS class names are not prose and are not matched). Reviewers also reject what the lint cannot see: triplets padded to three, a sentence that knocks down a strawman ("it is not X, it is Y"), a closing paragraph that restates the page, lists of fragments standing in for a paragraph, bold on ordinary words, and a heading every two sentences. Limitations are stated in place, with the alternative named. The "What X does not promise" sections stay. These rules govern `docs/`, `README.md`, `CONTRIBUTING.md`, and `GOVERNANCE.md`; `CHANGELOG.md` and `CONVENTIONS.md` follow their own genre, and decision-register IDs (`packages/protocol/decisions/`) stay out of `docs/` prose except on the two protocol pages.

## Environment & tooling quirks

- Workspace task names include `dev`, `build`, `test`, `type-check`, `lint`, and `clean`. Omit a task that does not apply; never add a no-op script that reports false success. Other names are reserved for real workspace-specific operations such as `start`, `migrate`, or `reset`. Cross-file conventions that Clippy and `tsc` do not cover remain review rules. `turbo.json` enables experimental Cargo workspace discovery (`futureFlags.experimentalCargoWorkspaces`) and custom Cargo commands (`experimentalTaskCommand`): crates under `crates/` are Turbo packages, the Cargo workspace identity is `kizunasync-cargo` (not `kizunasync`, which is the npm CLI shim). Unfiltered `bun run build` and `bun run test` include those crates (entrypoint `cargo build --locked`, workspace `cargo test --workspace --locked`). `bun run lint` is workspace Clippy with `-D warnings`. Root `dev` still `--filter`s the JavaScript workspaces so it does not `cargo run` the CLI binaries. `bun run cargo:test` remains the nextest gate. `kizunasync-cargo#test` sets `cache: true` explicitly: Turbo disables implicit Cargo caching when `~/.cargo/config.toml` (or other extra-repo Cargo config) exists, because it cannot hash those files; the explicit flag is the documented override and matches the entrypoint crate `build` tasks.
- `bun run update-deps` is a root maintainer script, not a Turbo task: `ncu -t minor -u` on every JavaScript workspace, then one `cargo upgrade` (compatible only) and `cargo update` on the Cargo workspace. `cargo-edit` is a host plugin on PATH or in `.cargo-tools`; missing it skips the Cargo half with an install hint.
- A workspace script invokes only tools and operations owned by that workspace. It never runs Turbo, changes into another workspace, or builds another package. Root scripts either delegate orchestration to Turbo or perform a genuinely repository-wide check.
- `build`, `test`, and `type-check` are cacheable when deterministic. Dev servers, watchers, local services, migrations, and side-effecting tasks set `cache: false`; only long-running processes set `persistent: true`.
- `build` depends on `^build`. Other tasks depend on upstream tasks only when they consume the upstream artifact; never add ordering dependencies to compensate for an undeclared package edge.
- Cacheable tasks that write artifacts declare only restorable `outputs` (`dist/**`, `.next/**` excluding `.next/cache/**`, and intentionally shared coverage). Tasks without artifacts declare no outputs. Keep Turbo's default source inputs and add only genuinely global files.
- Environment variables that change cacheable output belong in Turbo `env`/`globalEnv`; runtime secrets use `passThroughEnv` and never enter cached artifacts.
- **Env files live only at the repository root** (`.env`, `.env.local`, `.env.prod`, and the committed `.env.example`); no app, package, or example keeps its own `.env*`. Turborepo never loads env files, so each framework is pointed at the root: Vite apps set `envDir` to the repo root with a per-app `envPrefix` (`VITE_DEMO_`, `VITE_TODO_REACT_`, `VITE_TODO_VUE_`), Next apps call `loadEnvConfig(repoRoot)` from `@next/env`, and `examples/todo-expo/app.config.js` applies the root `.env` then `.env.local`. Variable names are product-prefixed (`WEBSITE_`, `NEXT_PUBLIC_INSPECTOR_`, `EXPO_PUBLIC_TODO_EXPO_`, and the Vite prefixes) so one file serves every workspace without leaking a value across them. Strict env mode is the default: a task sees only the names listed in its `env` or `passThroughEnv` entry in `turbo.json`. The root `dev` script wraps `turbo run dev` in `dotenv -e .env -e .env.local -o` so the same files also reach tasks that do not load env themselves, with `.env.local` winning over `.env` and both over the shell; `-o` and `-c` are mutually exclusive in `dotenv-cli` 11, so the cascade is spelled out with `-e`. Cacheable tasks list `$TURBO_ROOT$/.env` and `$TURBO_ROOT$/.env.local` in `inputs` (through `$TURBO_EXTENDS$` in package configs) so a root env change misses the cache.
- `clean` removes only generated artifacts and local tool caches, never source, lockfiles, configuration, databases, or `node_modules`. The root clean is `turbo run clean`.
- Run targeted work from the root with Turbo `--filter`; add a named root shortcut only for a frequent, semantically distinct workflow. Equivalent aliases are compatibility-only, documented, and temporary.
- CI and automation invoke the canonical root/Turbo tasks rather than duplicating tool commands.
- Build/start scripts pin `NODE_ENV=production` where it matters: the shell may export `NODE_ENV` globally and corrupt `next build`.
- `turbopack.root` is set in `apps/website/next.config.ts` (stray lockfiles in `$HOME` confuse workspace detection).
- bun uses the isolated linker (`bunfig.toml`); workspace binaries resolve through each workspace's own `node_modules/.bin/`. The Next apps run with `--webpack`.
- In automation, never rely on plain `cd`: use absolute paths or `builtin cd`.
- Verification gauntlet before any "done" claim: `bun run test` → `bun run type-check` → `bun run build`.

## Git & releases

- **Commits: short, English, lowercase, imperative, no body.** Conventional-commit prefixes (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`) with optional scope: `feat(website): add docs viewer`. One logical change per commit.
- **Never** add `Co-Authored-By` or any tool-attribution trailer.
- **`CHANGELOG.md` is mandatory** and follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): every user-visible change lands under `[Unreleased]` in the same PR, grouped `Added`/`Changed`/`Fixed`/`Removed`. Releases follow SemVer. Protocol-coupled packages version in lockstep. No Changesets configuration exists; `release-npm.yml`, `release-swift.yml`, and `release-kotlin.yml` build and publish every artifact from a `v*` tag on `main`.
- **`main` and `develop` are append-only.** Never rewrite their history and never force-push them.
- **Release flow:** merge `develop` into `main` with a merge commit, move `[Unreleased]` into a `[x.y.z] - YYYY-MM-DD` section, create the annotated tag `v<version>` on `main`, then push `main` and the tag. `release.yml` publishes every channel from that tag.
- Contributions: DCO sign-off, no CLA (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
