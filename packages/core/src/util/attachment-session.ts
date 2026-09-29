/**
 * The attachment observation protocol, owned once here so the React hook and
 * the Vue composable are adapters over it instead of two copies that drift.
 *
 * Follows ONE attachment reference at a time over the queue's per-ref watch
 * (never `client.on`: a global event would wake every unrelated reader on each
 * progress tick). Changing the reference drops the previous watch, emits `null`
 * so no field carries over, reads the new reference once, and re-subscribes.
 * A null reference is idle with no subscription.
 *
 * Every asynchronous continuation is guarded twice: a monotonic sequence token
 * keeps only the newest read, and the captured reference must still be the
 * current one, because the token alone cannot tell two references apart.
 *
 * `permanent` is what separates the two readings of `state: 'failed'`: false
 * means the next sync retries it, true means the transfer budget is spent and
 * only `retry()` puts the row back in the queue. That is why `retry()` forgives
 * the budget before it prefetches: on a permanent row a prefetch alone is a
 * no-op, because no drive claims it.
 */
// MARK: - Attachment session

import type { IAttachmentClient, TAttachmentStatus } from '../host/attachment-queue'

export interface IAttachmentSessionOptions {
  attachments: IAttachmentClient
  onStatus: (status: TAttachmentStatus | null) => void

  /** A queue call for the current reference rejected; stale references are dropped. */
  onError?: (cause: unknown) => void
}

export interface IAttachmentSession {
  /** Follow another reference, or `null`/`undefined` to go idle. */
  setRef(ref: string | null | undefined): void

  /** Re-read the current reference's status. */
  refresh(): void

  /** Fetch a peer's bytes without touching the transfer budget. */
  prefetch(): void

  /** Reset the attempt count, then drive the transfer again. */
  retry(): void

  /** Stop the transfer now. The row stays retryable. */
  cancel(): void

  /** Forget the reference and its sandbox bytes. */
  remove(): void

  /** Unsubscribe and invalidate every in-flight continuation. */
  dispose(): void
}

/** What one session mutates, shared by the functions below. */
interface ISessionState {
  readonly attachments: IAttachmentClient
  readonly onStatus: (status: TAttachmentStatus | null) => void
  readonly onError: ((cause: unknown) => void) | undefined
  currentRef: string | null
  seq: number
  unwatch: (() => void) | null

  /**
   * The last reference auto-fetched. Coming back to an earlier reference
   * re-arms the fetch only when another one was auto-fetched in between.
   */
  prefetchedFor: string | null
}

export const createAttachmentSession = (options: IAttachmentSessionOptions): IAttachmentSession => {
  const { attachments, onStatus, onError } = options
  const state: ISessionState = {
    attachments,
    onStatus,
    onError,
    currentRef: null,
    seq: 0,
    unwatch: null,
    prefetchedFor: null,
  }

  return {
    setRef: (next) => {
      setRef(state, next)
    },
    refresh: () => {
      if (state.currentRef !== null) {
        readStatus(state, state.currentRef)
      }
    },
    prefetch: () => {
      if (state.currentRef !== null) {
        fetchBytes(state, state.currentRef)
      }
    },
    retry: () => {
      retry(state)
    },
    cancel: () => {
      cancel(state)
    },
    remove: () => {
      remove(state)
    },
    dispose: () => {
      stopWatching(state)
      state.currentRef = null
    },
  }
}

/**
 * Hoisted declarations so the commit ⇄ readStatus ⇄ fetchBytes cycle resolves
 * without a temporal-dead-zone juggle.
 */
// MARK: - Status reads

function isStale(state: ISessionState, forRef: string): boolean {
  return state.currentRef !== forRef
}

/** The rejection handler of one queue call for `forRef`: a stale reference's failure is dropped. */
function reportFor(state: ISessionState, forRef: string): (cause: unknown) => void {
  return (cause) => {
    const { onError } = state

    if (!isStale(state, forRef)) {
      onError?.(cause)
    }
  }
}

/** A status read for one reference, as {@link commit} applies it. */
type TStatusRead = {
  forRef: string
  status: TAttachmentStatus | null
}

function commit(state: ISessionState, read: TStatusRead): void {
  const { forRef, status } = read
  const { onStatus } = state

  if (isStale(state, forRef)) {
    return
  }
  onStatus(status)

  // Auto-fetch a peer's bytes the first time a reference is seen with no local uri (a scheduled-but-unfetched download). Once per reference: the queue dedups the in-flight download, and a failure never loops because retry is manual.
  if (status !== null && status.localUri === null && state.prefetchedFor !== forRef) {
    state.prefetchedFor = forRef
    fetchBytes(state, forRef)
  }
}

function readStatus(state: ISessionState, forRef: string): void {
  const { attachments } = state

  if (isStale(state, forRef)) {
    return
  }
  const token = (state.seq += 1)

  void attachments
    .getStatus(forRef)
    .then((status) => {
      if (token === state.seq) {
        commit(state, { forRef, status })
      }
    })
    .catch(reportFor(state, forRef))
}

function fetchBytes(state: ISessionState, forRef: string): void {
  void state.attachments
    .resolveDownload(forRef)
    .then(() => {
      readStatus(state, forRef)
    })
    .catch(reportFor(state, forRef))
}

// MARK: - Following a reference

/** Drops the current watch and invalidates every in-flight continuation. */
function stopWatching(state: ISessionState): void {
  const { unwatch } = state

  unwatch?.()
  state.unwatch = null
  state.seq += 1
}

function setRef(state: ISessionState, next: string | null | undefined): void {
  const { attachments, onStatus } = state

  stopWatching(state)
  state.currentRef = next ?? null
  onStatus(null)
  const forRef = state.currentRef

  if (forRef === null) {
    return
  }
  readStatus(state, forRef)
  state.unwatch = attachments.watch(forRef, (status) => {
    commit(state, { forRef, status })
  })
}

// MARK: - Queue controls

function retry(state: ISessionState): void {
  const { attachments, currentRef: forRef } = state

  if (forRef === null) {
    return
  }
  void attachments
    .retry(forRef)
    .then(() => {
      if (isStale(state, forRef)) {
        return
      }
      // Cleared so the auto-fetch in `commit` arms again for this reference: the row is queued once more and its bytes are worth asking for.
      state.prefetchedFor = null
      fetchBytes(state, forRef)
    })
    .catch(reportFor(state, forRef))
}

function cancel(state: ISessionState): void {
  const { attachments, currentRef: forRef } = state

  if (forRef === null) {
    return
  }
  void attachments
    .cancel(forRef)
    .then(() => {
      readStatus(state, forRef)
    })
    .catch(reportFor(state, forRef))
}

function remove(state: ISessionState): void {
  const { attachments, currentRef: forRef } = state

  if (forRef === null) {
    return
  }
  void attachments
    .remove(forRef)
    .then(() => {
      readStatus(state, forRef)
    })
    .catch(reportFor(state, forRef))
}
