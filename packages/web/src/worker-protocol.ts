// MARK: - @kizunasync/web worker protocol

/**
 * The messages the page and the dedicated worker exchange. The worker owns the
 * Rust engine (`kizunasync-wasm`). Nothing on this wire is SQL: it is the engine's
 * own `(method, paramsJson) -> envelope` call surface, plus the two directions
 * the engine needs back on the page: the protocol remote and the event stream.
 *
 * `id` correlates a request with its `result`. The page mints the ids on
 * `open`/`call`/`close`; the worker mints its own for `remote`, which the page
 * answers with a `remote-result` carrying the same id. The two id spaces are
 * independent because the two senders are.
 */
export type TWorkerRequest =
  | { type: 'open'; id: number; configJson: string; wasmUrl?: string }
  | { type: 'call'; id: number; method: string; paramsJson: string }
  | { type: 'remote-result'; id: number; ok: true; value: string }
  | { type: 'remote-result'; id: number; ok: false; error: string }
  | { type: 'close'; id: number }

export type TWorkerResponse =
  | { type: 'result'; id: number; ok: true; value: string }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'remote'; id: number; kind: 'pull' | 'push'; requestJson: string }
  | { type: 'event'; eventJson: string }

/**
 * The attachment queue's crash recovery. The worker runs it as it opens the
 * store, once per database open; the page answers a client's own request for it
 * and forwards nothing (`worker-driver.ts`).
 */
export const CRASH_RECOVERY_METHOD = 'attachment_recover'
