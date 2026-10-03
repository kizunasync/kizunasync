/**
 * Serves `run-corpus.html` out of this directory. The page reaches two other
 * workspaces as data (the golden corpus under `packages/protocol/` and the query
 * parity vectors under `packages/core/`) and the worker it spawns loads the wasm
 * glue from `packages/web/src/wasm/`. The dev server must be allowed to read the
 * whole repository.
 *
 * The `node:` aliases stand in for the protocol harness's filesystem loader, which
 * rides along with `@kizunasync/core/conformance` even though this page never calls it
 * (`node-shims.ts`).
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// MARK: - Vite config for the browser conformance page

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '../../..')

export default defineConfig({
  root: here,
  server: {
    fs: {
      allow: [repositoryRoot],
    },
  },
  resolve: {
    alias: [
      {
        find: /^node:(fs|path|url)$/,
        replacement: resolve(here, 'node-shims.ts'),
      },
    ],
  },
})
