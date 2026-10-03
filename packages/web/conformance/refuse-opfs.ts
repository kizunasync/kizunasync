// MARK: - Refusing OPFS inside the worker

/**
 * The fallback exists for browsers that do not offer the OPFS synchronous-access
 * handle pool, and there are two shapes of that. In Safari before 17, Firefox
 * before 111 and any non-secure context the method is absent, so calling it throws
 * a synchronous `TypeError`; a private-mode window that refuses the storage access
 * rejects the call with a `SecurityError`. They are not interchangeable:
 * `web_sys`'s `get_directory` binding carries no `catch`, so only the rejection
 * becomes an `Err` the store can fall through on, while the absent method throws
 * straight out of the wasm frame. The lane therefore reproduces both.
 *
 * A third shape is an OPFS that exists and fails with any other error. That is not
 * a missing capability: a store that once opened there must not reopen empty on
 * IndexedDB, so the open fails with `STORE_UNAVAILABLE` instead.
 *
 * Deleting the own property does nothing: `getDirectory` lives on
 * `StorageManager.prototype`. The delete has to reach the prototype, or the
 * worker keeps the real method and reports `opfs-sahpool`.
 *
 * None of this ships. `page.addInitScript` reaches pages and frames but not a
 * dedicated worker's global, and the worker URL is built inside `worker-driver.ts`,
 * so a flag cannot ride on it either. The page wraps `Worker` instead, and the
 * blob module refuses the capability before importing the real entry.
 */

/**
 * How the worker's OPFS entry point is taken away: as the platform takes it
 * (`absent`), as a private-mode window refuses it (`rejecting`), or as an OPFS
 * that exists and fails (`failing`).
 */
export type TOpfsRefusal = 'absent' | 'rejecting' | 'failing'

const REFUSALS: Record<TOpfsRefusal, string> = {
  absent: 'delete Object.getPrototypeOf(navigator.storage).getDirectory',
  rejecting:
    "navigator.storage.getDirectory = () => Promise.reject(new DOMException('OPFS refused by the conformance page', 'SecurityError'))",
  failing: "navigator.storage.getDirectory = () => Promise.reject(new Error('OPFS failed on the conformance page'))",
}

/**
 * The wrapper buffers messages across its dynamic import. A worker delivers what
 * was posted before its script finished evaluating, and `worker.ts` registers its
 * listener during evaluation; behind an `await import` that registration is late,
 * so the driver's `open` would be dispatched into an empty listener set and the
 * engine would never open.
 */
function workerSource(refusal: TOpfsRefusal, entry: string): string {
  return [
    REFUSALS[refusal],
    'const queued = []',
    'const capture = (event) => { queued.push(event.data) }',
    "self.addEventListener('message', capture)",
    `await import(${JSON.stringify(entry)})`,
    "self.removeEventListener('message', capture)",
    "for (const data of queued) { self.dispatchEvent(new MessageEvent('message', { data })) }",
    '',
  ].join('\n')
}

/** Every worker this page spawns from now on opens without OPFS. */
export function refuseOpfsInWorkers(refusal: TOpfsRefusal): void {
  const RealWorker = globalThis.Worker

  class ConformanceWorker extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const entry = new URL(url, globalThis.location.href).href
      const blob = new Blob([workerSource(refusal, entry)], { type: 'text/javascript' })

      super(URL.createObjectURL(blob), options)
    }
  }
  globalThis.Worker = ConformanceWorker
}
