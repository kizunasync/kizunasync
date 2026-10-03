/**
 * @kizunasync/web worker: the Rust engine, off the main thread.
 *
 * A dedicated module Worker that owns the only engine: `kizunasync-wasm` compiled to
 * wasm32, with SQLite persisted through the OPFS synchronous-access-handle pool
 * (or the relaxed IndexedDB VFS where that is unavailable). Both need a worker
 * (`createSyncAccessHandle` is worker-only) and neither needs SharedArrayBuffer,
 * COOP or COEP.
 *
 * This file is the entry: it loads the generated glue, then hands
 * `worker-runtime.ts` a factory for the engine. The protocol, the FIFO ordering
 * and the remote round trips all live there, where a test can reach them.
 *
 * Browser only. There is no Worker under bun/node and the glue is a browser
 * module. The test runner never imports this file; only `worker-driver.ts`
 * spawns it, at runtime.
 */

import init, { KizunaSyncWasmEngine } from './wasm/kizunasync_wasm.js'
import { createWorkerRuntime, type IWasmEngine } from './worker-runtime'
import type { TWorkerRequest, TWorkerResponse } from './worker-protocol'

/** Typed without the WebWorker lib, which clashes with the DOM lib this package compiles against. */
const ctx = self as unknown as {
  postMessage(message: TWorkerResponse): void
  addEventListener(type: 'message', listener: (event: { data: TWorkerRequest }) => void): void
}

/**
 * Vite rewrites this `new URL(..., import.meta.url)` to the emitted asset, so the
 * worker resolves its own binary. Metro compiles `import.meta` to a registry only
 * the main bundle installs, so reading `.url` here throws on that path; the page
 * resolves the asset instead and sends `wasmUrl`, which this never reaches while
 * that is set.
 */
function bundledWasmUrl(): URL {
  try {
    return new URL('./wasm/kizunasync_wasm_bg.wasm', import.meta.url)
  } catch {
    throw new Error(
      'the kizunasync/web worker cannot locate kizunasync_wasm_bg.wasm: this bundler does not rewrite import.meta.url, so pass wasmUrl to createWebWorkerDriver',
    )
  }
}

async function loadEngine(wasmUrl?: string): Promise<IWasmEngine> {
  await init({ module_or_path: wasmUrl ?? bundledWasmUrl() })

  return new KizunaSyncWasmEngine()
}

const handle = createWorkerRuntime(loadEngine, (message) => {
  ctx.postMessage(message)
})

ctx.addEventListener('message', (event) => {
  handle(event.data)
})
