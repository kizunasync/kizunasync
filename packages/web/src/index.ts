/**
 * @kizunasync/web: the Kizuna web driver.
 *
 * The browser home of the Rust engine: `kizunasync-wasm` runs in a dedicated worker
 * over OPFS (or the relaxed IndexedDB fallback): no SharedArrayBuffer, no COOP
 * or COEP. Pass the driver to createKizunaSync from @kizunasync/core; everything else
 * (query API, reactivity) is shared across platforms. `createWebConnectivity` is
 * the matching IConnectivity adapter (navigator.onLine + online/offline events).
 */

export { createWebWorkerDriver, type IWebEngineDriver, type IWebWorkerDriverOptions, type TWasmUrl } from './worker-driver'
export { createWebConnectivity } from './connectivity'
export { createWebFileStore } from './file-store'
