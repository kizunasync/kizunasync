---
title: CI and CD
description: The GitHub Actions quality, live Supabase, Rust, native binding, conformance, release, and deployment lanes.
status: alpha
docType: reference
audience: contributor
---

# CI and CD

The repository has eight GitHub Actions workflows. A push to `develop` and every pull request, whatever its base branch, run the Linux lanes of `ci.yml` and `rust-ci.yml`; a push to any other branch runs nothing. A `v*` tag on `main` is the one production path: `release.yml` runs every lane, publishes the Swift package and the Maven artifacts, then the npm packages (the `kizunasync` CLI among them), then deploys the website and the public demo. Nothing else publishes or deploys, apart from a maintainer's manual dispatch of one of those workflows.

[Workflows](#workflows) and [Toolchain recorded by the repository](#toolchain-recorded-by-the-repository) are the inventory: what runs, and on which versions. [Bun/Turbo quality job](#bunturbo-quality-job), [Live Supabase database job](#live-supabase-database-job), [Live SQL conformance gate](#live-sql-conformance-gate), and [Rust workflow](#rust-workflow) walk one job each, step by step. [Release workflows](#release-workflows), [Documentation gates](#documentation-gates), [Deployment state](#deployment-state), and [Service-role key rule](#service-role-key-rule) cover what a tag triggers and the rules every job obeys. [Local commands](#local-commands) reproduces the gates on your own machine.

## Workflows

| File | Trigger | Jobs |
|---|---|---|
| `release.yml` | `v*` tag push | `guard`, then `ci` and `rust-ci` with `full: true`, then `release-swift` and `release-kotlin`, then `release-npm`, then `deploy-demo` and `deploy-website` |
| `ci.yml` | Push to `develop`, pull request to any branch, reusable `workflow_call` from `release.yml`, manual dispatch from `main` | `quality`, `db-tests` |
| `rust-ci.yml` | Push to `develop`, pull request to any branch, reusable `workflow_call` from `release.yml`, manual dispatch from `main` with a `full` boolean input | `changes`, `rust`, `msrv`, `wasm-build`, `browser-conformance`, `core-on-rust`, and ten path-filtered native jobs |
| `release-swift.yml` | Reusable `workflow_call` from `release.yml`, manual dispatch | XCFramework build and Swift package publish |
| `release-kotlin.yml` | Reusable `workflow_call` from `release.yml`, manual dispatch | Android AAR builds and Maven Central publish |
| `release-npm.yml` | Reusable `workflow_call` from `release.yml`, manual dispatch | Per-triple binary matrix and npm publish |
| `deploy-demo.yml` | Reusable `workflow_call` from `release.yml`, manual dispatch | `deploy-demo`: builds `apps/demo` and uploads it to Vercel |
| `deploy-website.yml` | Reusable `workflow_call` from `release.yml`, manual dispatch | `deploy-website`: builds `apps/website` with the Vercel CLI and uploads the prebuilt output to Vercel |

`ci.yml` and `rust-ci.yml` cancel an in-progress run when a new commit lands on the same non-`main` ref. Runs on `main` finish.

## Toolchain recorded by the repository

| Tool | Declared version | Source |
|---|---|---|
| [Bun](https://bun.sh/docs/installation), workspace | `bun@1.4.2`, with `engines.bun` at `>=1.3.0` | Root `packageManager` and `engines` |
| Bun, workflows | `1.4.2` | `BUN_VERSION` in `ci.yml`, `rust-ci.yml`, `release-npm.yml`, `release-swift.yml`, `release-kotlin.yml`, `deploy-demo.yml`, and `deploy-website.yml` |
| [Node](https://grokipedia.com/page/Node.js) | `^20.19.0 \|\| >=22.12.0` | Root `engines` |
| Turbo | `2.10.13-canary.4`, with experimental Cargo workspace discovery (`kizunasync-cargo`) and `experimentalTaskCommand` | Root `turbo.json` `futureFlags` |
| Supabase CLI | `^2.117.0` | `@kizunasync/supabase-pack` dev dependency; the workflow installs `latest` through `supabase/setup-cli@v3` |
| Next.js | `^16.3.4` | Website and sync-inspector dependency |
| Rust | Stable, plus rustfmt, clippy, and `llvm-tools` | `rust-toolchain.toml`, which rustup reads to install all three locally and in CI; `scripts/build-wasm.ts` archives the wasm32 SQLite objects with the `llvm-ar` that `llvm-tools` ships |
| Gradle | `8.7` wrapper, for the Kotlin binding and the Android example | The Rust workflow uses the committed wrapper |
| Android Gradle Plugin | `8.6.1` | Kotlin binding and Android example settings; wrapper 8.7 satisfies this pin |
| Android NDK | `r27c` | `release-kotlin.yml` and the AAR job |
| JDK | `17` | Kotlin build and workflow |
| clang with a WebAssembly target, exported as `CC_wasm32_unknown_unknown` | macOS: `CC_wasm32_unknown_unknown="$(brew --prefix llvm@21)/bin/clang"` (any Homebrew LLVM whose `clang -print-targets` lists `wasm32` works); Ubuntu: `clang` | The `wasm-build` job in `rust-ci.yml`, and `bun run cargo:wasm-check` locally; required because `sqlite-wasm-rs`'s build script compiles SQLite from C for the `wasm32-unknown-unknown` target |
| `CFLAGS_wasm32_unknown_unknown` for the same wasm32 clang build | `-std=gnu2x` on Linux | `.github/actions/wasm-toolchain` and `scripts/build-wasm.ts`; needed because `sqlite-wasm-rs`'s shim uses the C23 `[[noreturn]]` attribute and Linux clang otherwise defaults to gnu17, which rejects it |
| [binaryen](https://github.com/WebAssembly/binaryen) for `wasm-opt` | Pinned release `version_124` from GitHub releases (apt's `105` is too old) | `.github/actions/wasm-toolchain` downloads and checksums the release archive because Ubuntu 22.04's apt package predates the reference-types and multivalue features rustc 1.82+ emits for `wasm32-unknown-unknown`; `scripts/build-wasm.ts` enforces `MIN_BINARYEN = 116` on the resolved binary |
| [wasm-bindgen](https://crates.io/crates/wasm-bindgen) CLI | Whichever version `Cargo.lock` resolved for the `wasm-bindgen` crate | Nothing declares it twice: `.github/actions/wasm-toolchain` reads the version out of `Cargo.lock` and installs that, and `scripts/build-wasm.ts` reads the same line and refuses a CLI that does not match, because glue built by a different version does not instantiate |

These versions describe the monorepo and its CI, not consumer requirements.

## Bun/Turbo quality job

The `quality` job runs for pushes to `develop`, for pull requests, as a reusable `workflow_call` from `release.yml` with `full: true`, and on manual dispatch from `main`. It installs the shared [wasm](https://grokipedia.com/page/WebAssembly) toolchain from `.github/actions/wasm-toolchain`. It then runs `bun run cargo:wasm` before the Turbo tasks. That order matters, because the [Vite](https://vite.dev) builds bundle `packages/web/src/worker.ts`, and git ignores the generated glue that worker imports. It then runs `cargo build -p kizunasync-napi --target-dir target`. The app client that `createKizunaSync` returns opens the Rust engine on its first engine call, and without a loadable artifact that call fails with `ENGINE_UNAVAILABLE`. Every suite that uses an app client therefore needs the addon this step puts in `target/debug`.

```bash
bun install --frozen-lockfile
bun run turbo run type-check test build --ui stream
```

A develop push with a real previous commit appends `--affected` and sets `TURBO_SCM_BASE` to that commit, so the run scopes to the packages the push changed and their dependents; a `full` release run, a pull request, a first push to the branch, or a manual dispatch runs the full workspace instead, with `TURBO_SCM_BASE` falling back to `develop`. Checkout uses full history so Turbo can find the comparison base. The frozen lockfile prevents dependency re-resolution.

The three Turbo tasks delegate to workspace scripts:

- `type-check` runs the TypeScript command declared by each participating workspace, and a following step in the same job type-checks the root `scripts/*.ts` against `tsconfig.scripts.json`, which no workspace covers;
- `test` is normally `bun test` in each JavaScript workspace, plus `cargo test --workspace --locked` through the `kizunasync-cargo` workspace package, including the website documentation tests;
- `build` runs package and app build scripts, including [Next.js](https://nextjs.org) builds with the flags each app declares. With `experimentalCargoWorkspaces`, an unfiltered or `--affected` run also schedules Cargo `build` for entrypoint crates, as `cargo build --package=<crate> --locked`. The quality job therefore installs `libdbus-1-dev` for `kizunasync-cli` on Linux. It still builds `kizunasync-napi` explicitly before Turbo, so app-client tests have the addon even when `--affected` does not select that crate. The stricter Clippy, nextest, and `kizunasync-ffi/http` gates stay in `rust-ci.yml`.

The `quality` job installs the Rust toolchain through the shared wasm action, as the steps above show. It builds the N-API addon explicitly. Its suites are therefore real evidence for the addon lane, rather than a best-effort side effect of root postinstall. The `core-on-rust` job in the Rust workflow below builds and asserts the addon again on its own runner. It then runs the suite on that addon, so it supports an engine claim independent of `quality`.

## Live Supabase database job

The `db-tests` job starts the repository's Supabase stack rather than a bare [Postgres](https://grokipedia.com/page/PostgreSQL) service. The tests need Supabase Auth, Realtime, and Storage configuration. They also need the applied migrations and the API-exposed `kizunasync` schema that [SQL pack](../reference/sql-pack.md) documents. Supabase documents the stack itself in [Local development](https://supabase.com/docs/guides/local-development#quickstart). Kizuna adds one installable migration and generated per-project table configuration on top of it. [Local Supabase](../cli/local-supabase.md#2-apply-pending-local-migrations) is the same sequence run by hand.

The job:

1. Checks out the repository;
2. Installs the latest Supabase CLI through `supabase/setup-cli@v3`, which also installs its own Bun;
3. Installs Bun `1.4.2` after it, so later steps run the pinned version;
4. Fails unless `bun --version` prints `1.4.2`;
5. Runs `bun install --frozen-lockfile`;
6. Runs `bun run db:start`;
7. Polls Postgres at `127.0.0.1:55322` for at most 60 seconds;
8. Runs `bun run turbo run test --filter=@kizunasync/supabase-pack` with an explicit `SUPABASE_DB_URL`;
9. Runs `bun run --filter @kizunasync/supabase-pack test:scale` with the same `SUPABASE_DB_URL`. It seeds a 2,000,000-row synced table and writes 1,000,000 synced rows in one transaction. Before that write it commits a small synced write and runs `analyze` on `_change_pending`, so the write starts from the statistics a busy project has, with the queue recorded as empty. It checks that each run numbers every row exactly once with contiguous sequence numbers. It also samples the database backend's private memory during the seed and fails when the peak reaches 200 MiB, once it has read at least ten samples from the stack's database container. The default `test` script never runs these two tests;
10. Runs `cargo test -p kizunasync-cli --test postgres` with the same `SUPABASE_DB_URL`. This is the one lane where the CLI's DB-first commands execute the SQL they emit against a real pack instead of a `FakeApplier`, covering `init`, `sync`, `status`, `doctor`, `lint`, `jobs`, `upgrade`, and `deprovision`. It fails the job when any of those tests reports a skip;
11. Installs the wasm toolchain, runs `bun run cargo:wasm`, and installs Chromium;
12. Writes the repo-root `.env.local` from `supabase status` (`VITE_DEMO_SUPABASE_URL` / `VITE_DEMO_SUPABASE_PUBLISHABLE_KEY`), and fails when that reports no API URL or publishable key;
13. Runs `bun run --filter @kizunasync/web test:browser:demo`, uploading the [Playwright](https://playwright.dev) report when it fails;
14. Runs `bun run db:stop` even after a failure.

The database suites use `describe.skipIf` for developer machines with no reachable database. The workflow's reachability step fails the job instead, and it names the reason. A local convenience skip therefore cannot pass as a green database job. The CLI's Postgres suite keeps one skip for those same machines. Step 10 reads its own output back, so that skip fails the job here rather than passing.

Steps 11 to 13 are the demo browser lane, and this job runs it. `apps/demo` signs in anonymously, stages a row owned by a user the example migration seeds, and syncs both panes before it renders. Only a runner with the stack up can serve it. The two values the job writes to the repo-root `.env.local` are the URL and the publishable key this run's own stack issued, so the lane needs no secret. The hermetic `conformance` project runs in `rust-ci.yml` instead. `KSYNC_DEMO_LANE` keeps each job to the one dev server it needs.

## Live SQL conformance gate

`packages/supabase-pack/tests/conformance/corpus-vs-live-sql.test.ts` replays the corpus families its synchronous Postgres harness can model. A family is one recorded transcript that the test replays end to end. The test compares live [`kizunasync.pull`](../reference/sql-pack.md#kizunasyncpull) and [`kizunasync.push`](../reference/sql-pack.md#kizunasyncpush) results with the TypeScript oracle, the in-memory reference server the corpus was recorded against. Before it compares, it normalizes the values that cannot match byte for byte across runs. Those are the owner and table identifiers, and the non-reproducible sequence, [cursor](../resources/glossary.md#cursor), and deletion-time values. The pack defines both functions. The harness reaches them through the [`rpc`](https://supabase.com/docs/reference/javascript/rpc#parameters) call Supabase documents, not through [PostgREST](https://postgrest.org/) table access.

The current allowlist contains 46 replay families:

- 45 pinned `PASS-SEMANTIC`;
- 0 pinned `DIVERGED`;
- 1 pinned `UNSUPPORTED`;
- 0 errors.

The one unsupported case is the held-transaction fencing race that [Fencing and horizons](../sync/fencing-and-horizons.md) explains. A synchronous single-connection replay cannot orchestrate concurrent connections deterministically. It therefore cannot stage that race at all. Four [checkpoint](../resources/glossary.md#checkpoint)-reaping transcripts replay against the real [`kizunasync.reap_tombstones()`](../reference/sql-pack.md#kizunasyncreap_tombstones): `lifecycle/001`, `rebase/004`, and `lifecycle/005` reap through their seeded history, and `lifecycle/006` reaps in the middle of the transcript. The harness ages only the transcript's own tombstones past `_settings.tombstone_ttl_days`, then calls that function. The `CHECKPOINT_EXPIRED` horizon a pull sees is therefore the one the SQL derived. Separate database tests cover the SQL behavior that needs concurrent connections.

Every family is pinned to one outcome rather than checked as pass or fail. A `PASS-SEMANTIC` pin also accepts a byte-identical replay, because byte equality is the stronger result. A regression to divergence fails the gate, and an unsupported case that starts passing also fails it until the allowlist and its rationale are updated on purpose. The aggregate assertion of `45 / 0 / 1 / 0` catches net reshuffling that leaves the total unchanged.

This 46-family live replay is not the full corpus count. `packages/protocol/cases/manifest.json` holds 50 entries: the JavaScript and Rust runners execute 49 and skip 1, blocked on an open entry in [Protocol decisions](../resources/protocol-decisions.md). [Protocol overview](../sync/protocol-overview.md#conformance-boundary) describes what the corpus constrains, and [Test offline behavior](./test-offline-behavior.md#4-replay-the-protocol-corpus) runs the client half of it.

## Rust workflow

The `rust-ci` workflow runs for pushes to `develop`, for pull requests, as a reusable `workflow_call` from `release.yml` with `full: true`, and from manual dispatch on `main`, which takes a boolean `full` input (default `false`) that turns on every job regardless of the path filters. A `changes` job runs `dorny/paths-filter`, which compares a push with the previous `develop` commit and a pull request with its own changed files, and emits the eight outputs the expensive native lanes read. The path-filtered Linux jobs (`bindings-kotlin`, `examples-rust`, `todo-android-host`) run when their filter output is `true` or `full` is `true`; the macOS and packaging jobs (`bindings-swift`, `simulator-smoke`, `napi-prebuild`, `ffi-xcframework`, `ffi-aar`, `todo-ios-sim`, `todo-android-apk`) run only when `full` is `true`, regardless of the filters.

The unconditional `rust` job runs:

- `cargo fmt --all -- --check`;
- workspace clippy with warnings, `unwrap_used`, `expect_used`, and `panic` denied;
- `cargo check` and `cargo clippy` on `kizunasync-ffi` with its default (empty) feature set, the shape mobile embedders build, denying warnings;
- `cargo nextest run --workspace --features kizunasync-ffi/http --profile ci`;
- `cargo test --doc --workspace`;
- `cargo doc --workspace --no-deps` with `RUSTDOCFLAGS=-D warnings`, so a broken intra-doc link or a public item documenting a private one fails the job;
- `cargo run -p kizunasync-conformance`;
- `cargo deny check`;
- `bun run --filter @kizunasync/protocol check:gen-rust` for generated Rust module parity;
- `cargo build -p kizunasync-napi -p kizunasync-ffi -p kizunasync-cli`;
- [UniFFI](https://mozilla.github.io/uniffi-rs/) Swift and Kotlin generation for the clients [Swift and Kotlin](../getting-started/native-clients.md) documents, a binding shape check, and `git diff --exit-code` over `crates/kizunasync-ffi/bindings`.

The conformance binary prints `corpus: passed=<n> failed=<n> skipped_steps=<n>` and exits non-zero on any failure. It reports `passed=49 failed=0 skipped_steps=1` for the current manifest, where the skipped step is the pull step whose recorded request is not this client's identity pull.

`msrv` needs `rust` and runs on every event. It installs the exact toolchain named in the root `Cargo.toml`'s `rust-version` and runs `cargo check --workspace --locked --features kizunasync-ffi/http`. A dependency bump that raises the workspace's real minimum supported Rust version therefore fails here, instead of surfacing only on `stable`.

`core-on-rust` needs `rust` and runs on every event. It builds `kizunasync-napi`, asserts the addon exists, then runs the full `@kizunasync/core` suite on the engine an app gets. That engine is Rust through the addon, under the rules in [Engine selection](../getting-started/status.md#engine-selection). There is no rollback lane, because there is no rollback: without a loadable artifact the app client's first engine call fails with `ENGINE_UNAVAILABLE`, and the client keeps that failure. That suite includes the golden conformance corpus, which the Rust engine answers through the same transport a browser worker speaks.

`wasm-build` runs after the `rust` job passes and is otherwise unconditional. It needs only `rust`, carries no `changes` filter, and runs on every event. It builds `kizunasync-wasm` for `wasm32-unknown-unknown` on the `release-size` profile. It runs clippy over `kizunasync-engine`, `kizunasync-store`, `kizunasync-transfer`, and `kizunasync-wasm` for that target, denying warnings. It then runs `bun run cargo:wasm` to generate the browser glue, and `bun run wasm:smoke` to instantiate it and drive the engine. It runs `bun run check:wasm-glue`, which fails when a rebuild changes the `KizunaSyncWasmEngine` block of the committed `kizunasync_wasm.d.ts`. A last step [Brotli](https://grokipedia.com/page/Brotli)-compresses `kizunasync_wasm_bg.wasm` at quality 11. It prints the byte count with its verdict against a 1.5 MiB budget.

The check compares only the `KizunaSyncWasmEngine` block. The rest of the declarations is wasm-bindgen's internal symbol table, whose closure indices move with the compiler. The file may therefore change when the toolchain does. `kizunasync-store`'s `sqlite-wasm-rs` backend compiles [SQLite](https://grokipedia.com/page/SQLite) from C for that target. The wasm32 Rust target, `clang`, binaryen, and the `wasm-bindgen` CLI pinned to the version in `Cargo.lock` all come from the shared `.github/actions/wasm-toolchain` composite action. That action's header names every job that consumes it, and it exports `CC_wasm32_unknown_unknown` for `cc-rs` to find. `bun run cargo:wasm-check` runs the same build locally. The size budget is not final, so the Brotli step carries `continue-on-error` and annotates the run instead of failing it. `brotli -q 11 -c packages/web/src/wasm/kizunasync_wasm_bg.wasm | wc -c` reproduces the number locally.

`browser-conformance` runs after `wasm-build` and is also unconditional. It rebuilds the glue with the same composite action, because git ignores that output and no job passes it on. It installs Chromium through `bunx playwright install --with-deps chromium`, then runs `bun run --filter @kizunasync/web test:browser`. That lane replays the executable client corpus and the query parity vectors against the wasm engine, through the `@kizunasync/web` worker transport.

The lane also covers five browser-only obligations. A follower tab calls through the leader tab, and it takes over with a worker of its own when the leader closes. Both shapes that have no [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) pool reach the `relaxed-idb` store at relaxed durability. The default path reports `opfs-sahpool` at full durability, and it reads a row back after the same database is closed and reopened. Two databases in one page each get the pool and keep only their own rows. A second worker on a held store fails with an error rather than falling back to [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) in silence.

The lane sits outside the Turbo `test` pipeline on purpose, because it needs a browser and a built glue. When it fails, it uploads the Playwright report as an artifact.

### Conditional Rust/native jobs

This table summarizes the purpose of each job, but keep in mind that it doesn't guarantee the latest run is passing. For Android jobs, we use the committed [Gradle](https://gradle.org) 8.7 wrapper together with Android Gradle Plugin 8.6.1. The JVM-only host lane does not set up the SDK environment variables, so it never configures the Android plugin. For AAR and APK jobs, the plugin is configured when the Android SDK is present. Both `ffi-aar` and `todo-android-apk` jobs run on `ubuntu-24.04` because the version of `cargo-ndk` used by cargo-binstall requires glibc 2.39. However, the Android `.so` objects bundled by these jobs still come from the Android NDK. The `napi-prebuild` job for Linux stays on `ubuntu-22.04` so that any published Node addon will have a glibc 2.35 baseline. The wasm cache job (`kizunasync-wasm`) and `deploy-demo` also use `ubuntu-22.04` to match the cache key, since binaries built on 24.04 won’t run on 22.04. All other Linux jobs use `ubuntu-24.04`. Since GitHub will shift the `ubuntu-latest` tag to Ubuntu 26.04 on October 19, 2026, explicit image versions are used rather than relying on the floating tag.

| Job                 | Intended check or artifact |
|---------------------|---------------------------|
| `bindings-kotlin`   | Runs shared scenarios on the generated UniFFI binding with Gradle and JUnit on JDK 17 |
| `bindings-swift`    | Runs shared scenarios on the generated UniFFI binding using `swift test` |
| `examples-rust`     | Runs engine probe, tests, and type-check for all three JavaScript example workspaces |
| `simulator-smoke`   | Builds, installs, and launches the [Expo](../getting-started/expo.md) iOS simulator, checks for a file showing the app chose `rust`, and verifies currency of the committed `packages/rn-uniffi/src/generated` Turbo Module with `git diff --exit-code` |
| `napi-prebuild`     | Builds and packages release N-API artifacts for `linux-x64`, `linux-arm64`, `darwin-arm64`, and `win32-x64` (see [Native packaging](../resources/native-packaging.md#npm-release)) |
| `ffi-xcframework`   | Produces iOS and iOS Simulator [XCFramework](../resources/native-packaging.md#xcframework) artifact |
| `ffi-aar`           | Builds an [Android AAR](../resources/native-packaging.md#android-aar) with arm64-v8a, armeabi-v7a, and x86_64 libraries (CI artifact only) |
| `todo-ios-sim`      | Runs native iOS example host tests, builds, and launches in the simulator |
| `todo-android-host` | Runs JVM host tests for the native Android example app |
| `todo-android-apk`  | Assembles the native Android APK (CI artifact only)          |

With path filters, a successful workflow may skip jobs that aren't relevant to a given change. Also, any N-API, XCFramework, AAR, or APK produced here are only temporary CI artifacts, not public releases. Simulator and assembly jobs do not serve as evidence of running on real physical devices.

Both `bun run test:swift` and `bun run test:todo-ios` execute `scripts/check-xcframework-fresh.sh` before running `swift test`. That shell script halts execution with a clear message prompting you to `bun run cargo:xcframework` if the built `KizunaSyncFfi.xcframework` is out of date compared to the Rust source. This means a stale local framework cannot quietly pass the tests. The `todo-ios-sim` job installs XcodeGen, runs `xcodegen generate`, and then invokes `xcodebuild build` with the relevant scheme and platform for the iOS Simulator, making sure the SwiftUI app shell builds against the current `TodoIosCore` and `KizunaSync` products. For `ffi-aar`, the job runs `./gradlew :android:testDebugUnitTest` to exercise `KizunaSyncConnectivityPathMonitor` and `KizunaSyncProcessForegroundSource` in a JVM environment using Robolectric.

## Release workflows

A pushed `v*` tag on `main` runs `release.yml`. Its `guard` job checks that the tagged commit is reachable from `origin/main` and resolves the version from the tag, then `ci` and `rust-ci` run with `full: true`, then `release-swift.yml` and `release-kotlin.yml` build and publish under that same version, then `release-npm.yml` does the same, then `deploy-demo.yml` and `deploy-website.yml` upload the public demo and the website. `release-npm.yml` waits for the other two because the React Native module inside `kizunasync` resolves its engine from the `KizunaSyncEngine` Swift product and from `com.kizunasync:kizunasync-engine` at the version it publishes. Each of the three release workflows keeps its own `workflow_dispatch` too, for a manual run against an explicit `version` input. A version starting with `0.` creates the GitHub Release as a prerelease.

| Workflow | Builds | Publishes to | Secrets |
|---|---|---|---|
| `release-swift.yml` | The `KizunaSyncFfi.xcframework` zip and its checksum, after `cargo:bindgen:check` | The matching GitHub Release, then a version tag on `kizunasync/kizunasync-swift`, which is the coordinate [Swift: Installing](../reference/swift/installing.md) gives readers; that package exports the `KizunaSync` and `KizunaSyncEngine` products | `KSYNC_SWIFT_DEPLOY_KEY` |
| `release-kotlin.yml` | The client and engine AARs through `scripts/build-android-aar.sh` on JDK 17, Gradle 8.7, and NDK r27c | Maven Central as `com.kizunasync:kizunasync`, which is the coordinate [Kotlin: Installing](../reference/kotlin/installing.md) gives readers, and `com.kizunasync:kizunasync-engine`, which it depends on, plus both AARs on the matching GitHub Release | `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `MAVEN_SIGNING_KEY`, `MAVEN_SIGNING_KEY_ID`, `MAVEN_SIGNING_PASSWORD` |
| `release-npm.yml` | Release N-API and CLI binaries per triple, the browser wasm glue, then the staged packages | npm for the five `@kizunasync/<platform>` packages and then `kizunasync`, the coordinate [JavaScript: Installing](../reference/javascript/installing.md) and [Install](../cli/install.md) give readers; the CLI binaries on the matching GitHub Release | none |

Each of the three resolves its version from `release.yml`'s `guard` output or, on manual dispatch, the `version` input. It refuses a version that does not match `X.Y.Z` with an optional prerelease identifier, and one that disagrees with root `Cargo.toml`'s `[workspace.package].version` or root `package.json`'s `version`. A mistagged release therefore fails before any artifact builds. `release-npm.yml` chooses each package's npm dist-tag from that package's own registry history rather than from the release version alone: while a package carries no stable version yet, every release publishes under `latest`, so a plain `npx kizunasync` still resolves to a runnable version; once a package has its first stable version, a further stable release stays on `latest` and a prerelease moves to its own identifier tag (`alpha`, `beta`, `rc`). The publish job installs npm 11.20.0 and authenticates with GitHub OIDC. It also asserts every built binary exceeds 100 000 bytes before staging it.

The npm binary matrix covers `darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`, and `win32-x64-msvc`. Each triple becomes one `@kizunasync/<triple>` package with `os` and `cpu` set, carrying the `kizunasync` binary under `bin/` and the N-API library at the package root. `kizunasync` pins the five as optional dependencies, so npm installs only the package your platform matches.

The publish job builds the browser glue through the same `.github/actions/wasm-toolchain` composite action before it stages. `kizunasync/web` publishes its `src/wasm/` directory, and two of those four files are generated rather than tracked. `scripts/prepare-npm-release.ts` stops the run when the staged web package lacks them. A lane that skipped the build therefore cannot publish a package whose worker fails to instantiate the engine.

The full CI runs on a `v*` tag, which also runs the macOS and Windows jobs in `rust-ci.yml`'s `full` lane and in `release-npm.yml`'s binary matrix plus `release-swift.yml`'s own macOS build, and it runs on demand through `workflow_dispatch` on `rust-ci.yml` with `full: true`.

## Documentation gates

The website test suite treats the public docs registry as an executable boundary:

- every registered file exists, and slugs and file paths are unique;
- every Markdown document under `docs/` is registered exactly once, together with `GOVERNANCE.md` as the one registered root document;
- a page's YAML `title`, its H1, and its registry title are the same string;
- the closing heading matches the page's group and `docType`;
- public links resolve to existing repository targets, and every tracked Markdown file's relative targets and heading anchors resolve;
- links between registered documents resolve to the expected in-site route;
- reader-run `kizunasync` commands never use the cargo debug binary.

`apps/website/lib/copy.test.ts` runs the prose lint over the same files: no em dash, no banned filler, no AI lexicon, no machine-writing tells, and no `here` link text.

The website Turbo build inputs include both `../../docs/**` and `../../GOVERNANCE.md`, so a governance edit invalidates the same build cache that consumes it. Its test task inputs include `../../**/*.md`, matching the repository-wide link and anchor audit.

## Deployment state

Two workflows deploy, and `release.yml` calls both once the three release workflows have published. Each also accepts a manual dispatch. Both workflows read `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and `VERCEL_TOKEN` from the secrets of their GitHub Environment.

`deploy-demo.yml` runs against the GitHub Environment `demo`. It builds `apps/demo` with the four `VITE_DEMO_*` values it reads from GitHub Actions variables, copies `apps/demo/dist` to `$RUNNER_TEMP/demo-deploy`, and runs `bunx vercel deploy --prod --yes` from there as a static deployment. The workflow carries no database credential.

`deploy-website.yml` runs against the GitHub Environment `website`. It checks out the full history, because the site reads its modified date from `git log`. From the repository root it runs `bunx vercel pull --yes --environment=production` and `bunx vercel build --prod` with `NODE_ENV=production`. It then moves `.git` aside for the one command that deploys, `bunx vercel deploy --prebuilt --prod --yes`, run from the repository root, because the prebuilt functions name files of the checkout by path and those files have to be inside the uploaded folder. The website build consumes no generated workspace artifact, so the job installs no Rust or wasm toolchain.

## Service-role key rule

The [sync inspector](../resources/repository-layout.md#tree) needs `INSPECTOR_SUPABASE_SERVICE_ROLE_KEY` for server-side reads of non-public Kizuna objects. A future host stores that value as a server-only secret. It never uses a `NEXT_PUBLIC_*` name, never enters a client component prop, and is never embedded in a browser bundle.

The browser-side inspector client uses only the project URL and the publishable key. A service-role key does what Supabase describes under [bypassing Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security), so it reads every Kizuna-owned table regardless of policy and must not cross the server boundary. The [grants the pack installs](../reference/sql-pack.md#grants-and-security) are what the browser client relies on instead.

## Local commands

Run the smallest lane relevant to a change:

```bash
bun test apps/website/lib/docs.test.ts
bun test packages/core
bun test packages/supabase
cargo test -p kizunasync-cli
bun run cargo:conformance
```

Live SQL tests need [`bun run db:start`](../cli/local-supabase.md#1-start-the-stack). Stop the stack with [`bun run db:stop`](../cli/local-supabase.md#4-stop-without-losing-data). [`db:reset`](../cli/local-supabase.md#5-reset-only-when-you-mean-it) destroys and recreates local data, so it is no substitute for startup.

[Build and test](../resources/contribute.md#1-build-and-test) has the full workspace setup and check sequence a contributor runs before opening a pull request.

## Related pages

- [Project status](../getting-started/status.md)
- [Roadmap](../resources/roadmap.md)
- [Test offline behavior](./test-offline-behavior.md)
- [Contributing](../../CONTRIBUTING.md)
