import { ETransferError } from '../ports/transfer'

// MARK: - withDeadline

/**
 * auth-js issues `getSession()` / `refreshSession()` with no fetch timeout and
 * no AbortSignal (unlike the RPC remote's own AbortController deadline). On
 * a half-open socket (sleep/wake, a network switch) either call can hang for
 * minutes and hold the caller's in-flight slot forever. auth-js exposes no way
 * to abort the underlying request; this only bounds how long the wait lasts.
 * When the deadline wins, `run()` is left to finish on its own and its
 * late settlement is observed so it can never surface as an unhandled
 * rejection. For `getSession`/`refreshSession` a late completion only updates
 * auth storage and is harmless to drop.
 */
export interface IDeadlineOptions {
  /**
   * Milliseconds `run()` may take before the deadline wins. `<= 0` disables
   * the deadline entirely: no timer is armed and `run()` is returned as is,
   * same convention as `requestTimeoutMs` in the RPC remote.
   */
  timeoutMs: number

  /**
   * Builds the rejection thrown when the deadline wins. Called lazily, only
   * when the timer fires, so a caller can attach fresh context.
   */
  onTimeout: () => Error

  /**
   * Injectable timer pair (testability): defaults to the platform
   * setTimeout/clearTimeout.
   */
  setTimer?: (callback: () => void, delayMs: number) => unknown

  clearTimer?: (handle: unknown) => void
}

export const withDeadline = <T>(run: () => Promise<T>, options: IDeadlineOptions): Promise<T> => {
  const { timeoutMs, onTimeout } = options
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  if (timeoutMs <= 0) {
    return run()
  }
  // Started once, outside the raced promise, so a synchronous throw from `run` becomes a rejection instead of escaping as a thrown exception.
  const runPromise = Promise.resolve().then(run)

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimer(() => {
      if (settled) {
        return
      }
      settled = true
      reject(onTimeout())
    }, timeoutMs)

    runPromise.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        clearTimer(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) {
          return
        }
        settled = true
        clearTimer(timer)
        reject(error)
      },
    )
    // Belt-and-braces: keeps a settlement that arrives AFTER the deadline already won from ever registering as an unhandled rejection, even though the .then() above already attaches a rejection handler.
    void runPromise.catch(() => undefined)
  })
}

// MARK: - createRequestSignal

export interface ICreateRequestSignalOptions {
  /**
   * Milliseconds before the deadline aborts the returned signal. `<= 0` or
   * omitted arms no timer.
   */
  timeoutMs?: number

  /**
   * A caller-controlled abort (e.g. `IUploadHandle.abort()`) forwarded onto
   * the returned signal. Aborting the parent is NEVER reported as a timeout.
   */
  parentSignal?: AbortSignal

  /**
   * Injectable timer pair (testability): defaults to the platform
   * setTimeout/clearTimeout.
   */
  setTimer?: (callback: () => void, delayMs: number) => unknown

  clearTimer?: (handle: unknown) => void
}

export interface IRequestSignal {
  /** Pass to `fetch()` / `.abortSignal()` for this one request. */
  signal: AbortSignal

  /**
   * True once the deadline timer (not the parent) aborted `signal`; read
   * this from the catch block before deciding `ETransferError.timedOut`
   * versus a plain abort or network failure.
   */
  timedOut(): boolean

  /**
   * Clears the timer and detaches the parent-abort listener. Always call
   * once the request settles, success or failure.
   */
  release(): void
}

/**
 * Builds a per-request `AbortSignal` bounded by a deadline AND forwarding a
 * caller's own abort, so every fetch/`.abortSignal()` call across the
 * transfer adapters shares one answer to "which of these two reasons ended
 * the request" instead of duplicating the race per call site.
 */
export const createRequestSignal = (options: ICreateRequestSignalOptions = {}): IRequestSignal => {
  const { timeoutMs = 0, parentSignal, setTimer, clearTimer } = options
  const armTimer = setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const disarmTimer = clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const controller = new AbortController()
  let didTimeOut = false
  let timer: unknown = null

  const onParentAbort = (): void => {
    controller.abort()
  }

  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      controller.abort()
    } else {
      parentSignal.addEventListener('abort', onParentAbort)
    }
  }

  if (timeoutMs > 0) {
    timer = armTimer(() => {
      if (!controller.signal.aborted) {
        didTimeOut = true
        controller.abort()
      }
    }, timeoutMs)
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    release: () => {
      if (timer !== null) {
        disarmTimer(timer)
        timer = null
      }
      if (parentSignal !== undefined) {
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    },
  }
}

// MARK: - Transfer timeout defaults

/**
 * Deadline for short control requests: session lookup, TUS create and offset
 * probe, createSignedUrl, attachment_confirm, attachment_vacuum,
 * storage.remove, metadata. Matches the RPC remote's own deadline
 * (DEFAULT_REQUEST_TIMEOUT_MS, rpc-remote.ts) so one attempt stays inside the
 * scheduler's stall window in the common case.
 */
export const DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS = 30_000

/**
 * Deadline for requests that carry bytes: the single-shot upload, each TUS
 * chunk (6 MiB), and the download fetch. Kept separate from
 * {@link DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS}: a 6 MiB body on a slow mobile
 * link legitimately takes far longer than a control request, so one constant
 * cannot serve both.
 */
export const DEFAULT_TRANSFER_BYTES_TIMEOUT_MS = 120_000

// MARK: - createTransferTimeoutError

export interface ICreateTransferTimeoutErrorOptions {
  /** Short verb phrase naming the request that timed out (e.g. 'upload', 'sign'). */
  operation: string

  timeoutMs: number

  /** Extra context appended in parentheses (e.g. which sub-request within the operation). */
  detail?: string
}

/**
 * Builds the retryable, `ETransferError.timedOut`-coded rejection for a
 * blown deadline: one implementation shared by every transfer adapter's
 * deadline (TUS requests, non-TUS Storage/RPC calls, and the Expo download
 * decorator).
 */
export const createTransferTimeoutError = (options: ICreateTransferTimeoutErrorOptions): Error => {
  const { operation, timeoutMs, detail } = options
  const suffix = detail === undefined ? '' : ` (${detail})`

  return Object.assign(new Error(`attachment ${operation} timed out after ${timeoutMs}ms${suffix}`), {
    code: ETransferError.timedOut,
  })
}
