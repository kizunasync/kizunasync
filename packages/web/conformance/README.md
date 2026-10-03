<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">Browser conformance lane</span>
</h1>

The wasm engine, proven in a real browser. `run-corpus.html` builds the `@kizunasync/web` driver and drives the golden client corpus and the query parity vectors through its `engineTransport`, the same seam `packages/core/src/conformance/transport-client.test.ts` drives through the N-API addon under Bun. Playwright then adds the obligations that only exist in a browser.

| Spec | What it asserts |
| --- | --- |
| `corpus.spec.ts` | Whole executable corpus through the worker transport: 49 passed, 0 failed, 1 skipped, no page error |
| `parity.spec.ts` | Every query parity vector agrees with the TypeScript oracle; oracle carries no duplicate name |
| `multi-tab.spec.ts` | Follower tab calls answered by the leader; promotion with its own worker when the leader closes |
| `fallback.spec.ts` | Both no-OPFS shapes (method absent, private-mode `SecurityError`) reach `relaxed-idb` at relaxed durability; an OPFS that exists and fails with any other error fails the open with `STORE_UNAVAILABLE` and creates no IndexedDB store |
| `durability.spec.ts` | Default path is `opfs-sahpool` at full durability; a row written before close is read back after reopen |
| `two-databases.spec.ts` | Two databases in one page each get the OPFS pool and keep only their own rows |
| `busy.spec.ts` | A second worker on a held store retries and then fails loud, rather than falling back to IndexedDB silently |

`demo.spec.ts` is the eighth file here and belongs to the demo project; see below.

## Get started

```bash
bun run cargo:wasm
bunx playwright install chromium
bun run --filter @kizunasync/web test:browser
```

The lane sits outside the Turbo `test` pipeline: it needs a browser and a built engine. `bun test` in this package stays on `src/**`, so these `*.spec.ts` files never run without Playwright. Package `type-check` compiles this directory as well as `src`.

## Never run one project twice at once

Playwright clears a project's `outputDir` when a run starts. A second invocation of the same project deletes the trace the first is still writing, and the first fails in `browserContext.close` with `ENOENT` on a `.network` file even though every assertion passed.

CI runs one invocation. Locally, do not start a lane while another is running. Give an ad-hoc loop its own output directory:

```bash
bunx playwright test --project=conformance --output=/tmp/pw-loop/$i --reporter=list
```

## Two projects

`playwright.config.ts` declares `conformance` and `demo`. They are not interchangeable.

`conformance` is hermetic: browser plus glue on disk. `test:browser` selects it and ignores `demo.spec.ts`. The `browser-conformance` job in `rust-ci.yml` runs it.

`demo` drives `apps/demo`, which signs in anonymously, stages a fixture-owned row, and syncs both panes before render. It needs the local Supabase stack and the repo-root `.env` / `.env.local` demo keys. The `db-tests` job in `ci.yml` builds the glue, installs Chromium, writes those keys from `supabase status`, and runs `bun run --filter @kizunasync/web test:browser:demo`. `KSYNC_DEMO_LANE` keeps the demo's dev server out of the hermetic job.

## Test-only machinery

`?opfs=absent`, `?opfs=off` and `?opfs=failing` wrap `globalThis.Worker` so the spawned worker is a blob module that takes OPFS away, or makes it fail, before importing the real entry. Playwright's `page.addInitScript` never reaches a dedicated worker's global, and the worker URL is built inside `worker-driver.ts`. The wrapper buffers messages across its dynamic import so the driver's `open` is not lost. None of this exists in shipped code. `refuse-opfs.ts` carries the three shapes and why the first two are not one.

Corpus cases run on the private in-memory store, with a distinct driver name each so no two share a lock or channel. That is a speed choice: the sahpool takes one pool directory per database name, so a page may hold several OPFS databases at once (`two-databases.spec.ts`). Store obligations sit where they can be asserted precisely in `durability.spec.ts`; the demo's reload spec covers survival across a real page load in the `db-tests` lane.

Everything that closes an engine awaits the driver's teardown through `whenClosed()`, which settles once the worker is terminated. That lets reopen happen in the same page without racing the outgoing worker for the store it still holds.

## Related

- [`@kizunasync/web`](../README.md)
- [`apps/demo`](../../../apps/demo/README.md)
- [`@kizunasync/protocol`](../../protocol/README.md)
