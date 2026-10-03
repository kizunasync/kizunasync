/**
 * Chromium only, and deliberately serial: every spec opens dedicated workers that
 * each instantiate the 3 MB wasm engine and take an OPFS access-handle pool.
 * Parallel workers would measure the runner, not the engine.
 *
 * Two projects, not interchangeable. `conformance` is hermetic: a browser and the
 * wasm glue on disk (`bun run cargo:wasm`). That is why `browser-conformance` in
 * rust-ci.yml can run it. `demo` drives `apps/demo`, whose boot signs in against
 * a live Supabase stack before it renders anything. Locally that is
 * `test:browser:demo`, which sets `KSYNC_DEMO_LANE=1`. In CI it is the `db-tests`
 * job of ci.yml, which starts the stack and writes the demo keys into the
 * repo-root `.env.local` before the same script.
 *
 * Neither lane is part of the turbo `test` pipeline. Run them with
 * `bun run --filter @kizunasync/web test:browser` and `… test:browser:demo`.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// MARK: - The browser lanes

const PORT = 5178

/**
 * `localhost`, not `127.0.0.1`: Vite binds the loopback name, and both are secure
 * origins, which OPFS and the Web Locks the election needs both require.
 */
const ORIGIN = `http://localhost:${PORT}`

const DEMO_PORT = 5179

const DEMO_ORIGIN = `http://localhost:${DEMO_PORT}`

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/demo')

const DEMO_SPEC = /demo\.spec\.ts$/

/**
 * Set by the `test:browser:demo` script alone. Playwright starts every `webServer`
 * entry whatever `--project` selects, so listing both unconditionally would start
 * the demo's dev server inside the hermetic CI job. The flag keeps each lane to
 * the server it needs; the two package scripts are the supported entry points.
 */
const isDemoLane = process.env.KSYNC_DEMO_LANE === '1'

const conformanceServer = {
  command: `vite --config conformance/vite.config.ts --port ${PORT} --strictPort`,
  url: `${ORIGIN}/run-corpus.html`,
  reuseExistingServer: process.env.CI === undefined,
  timeout: 120_000,
}

/**
 * `apps/demo`'s own dev server. Vite `envDir` is the repo root, where the
 * product-prefixed demo keys live.
 */
const demoServer = {
  command: `vite --port ${DEMO_PORT} --strictPort`,
  cwd: DEMO_ROOT,
  url: DEMO_ORIGIN,
  reuseExistingServer: process.env.CI === undefined,
  timeout: 120_000,
  /**
   * Bun exports the repo-root `.env` into `process.env`, and a developer's own
   * `VITE_DEMO_TURNSTILE_SITE_KEY` there would switch the captcha on for this
   * headless run, which cannot pass it. This lane always runs without it.
   */
  env: { ...process.env, VITE_DEMO_TURNSTILE_SITE_KEY: '' },
}

export default defineConfig({
  testDir: './conformance',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  /** The corpus lane opens 38 engines in one page; the rest settle in seconds. */
  timeout: 10 * 60 * 1000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
  },
  /**
   * One output directory per project. A run of one lane must not clear the
   * other's artifacts.
   *
   * Separate directories still do not make a project safe to run twice at once.
   * Playwright clears a project's directory when a run starts. A second
   * invocation of the same project deletes the trace the first is still writing,
   * and that one fails in `browserContext.close` with an `ENOENT` on a `.network`
   * file although every assertion passed. It lands on whichever test wrote the
   * most trace data, and looks like a flake in `parity` or `corpus`. CI runs one
   * invocation. For an ad-hoc loop, pass `--output` a directory of its own per
   * run.
   */
  projects: [
    {
      name: 'conformance',
      testIgnore: DEMO_SPEC,
      outputDir: './test-results/conformance',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'demo',
      testMatch: DEMO_SPEC,
      outputDir: './test-results/demo',
      use: { ...devices['Desktop Chrome'], baseURL: DEMO_ORIGIN },
    },
  ],
  webServer: isDemoLane ? [demoServer] : [conformanceServer],
})
