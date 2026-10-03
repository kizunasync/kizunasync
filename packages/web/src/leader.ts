// MARK: - @kizunasync/web leader election

/**
 * Every tab on a database races for one exclusive Web Lock named after it. The
 * winner runs the engine in its own worker; the losers wait on the same lock and
 * are promoted the moment the winner gives it up: on `close()`, when its engine
 * fails under it, or when its page goes away and the browser releases the lock.
 *
 * The lock is held by a promise this module resolves, never by one that cannot
 * settle. `release()` makes the hand-over prompt in life and observable in a
 * test. A promotion that throws hands the lock back; the tab must not claim to
 * lead a database it never opened.
 */

import { createTag, SCOPE_PREFIX } from './leader-protocol'
import type { TLeaderResponse } from './leader-protocol'

type TLeaderRole = 'leader' | 'follower'

export interface ILeaderFailure {
  readonly error: unknown

  /**
   * False without `navigator.locks`: nothing is racing for this database, so the
   * page that failed to open it is the only one that was ever going to.
   */
  readonly canAnotherTabLead: boolean
}

export interface ILeaderCallbacks {
  /**
   * Runs once this page owns the database; the lock is held until it settles.
   * `instance` names this page's turn as leader on the channel.
   */
  onLeader(instance: string): void | Promise<void>

  /** Runs synchronously, before the lock is requested. */
  onFollower(): void

  /** Runs when `onLeader` failed. The page is a follower again and the lock is free. */
  onLeaderFailed(failure: ILeaderFailure): void
}

export interface ILeaderElection {
  readonly role: TLeaderRole

  /** Hand the lock to the next tab. A page still queued for it stops waiting. */
  release(): Promise<void>
}

function readLockManager(): LockManager | undefined {
  const scope = globalThis as { navigator?: { locks?: LockManager } }

  return scope.navigator?.locks
}

/** Web Locks exist only in a secure context: without them no two tabs can share a database. */
export function hasWebLocks(): boolean {
  return readLockManager() !== undefined
}

/**
 * Posts `leader-closed` while the page is unloading. A follower can promote on
 * that message without waiting out `closeTimeoutMs`.
 *
 * The browser releases this page's Web Lock when the page goes away. The grant
 * that promotes the next tab is a different task source from the channel, with
 * no ordering against it. A promoted tab that has not heard `leader-closed`
 * cannot trust its `accepted` flags, so it waits out `closeTimeoutMs` before it
 * takes over. Posting the goodbye here skips that wait for a tab the user closed
 * (disposed tabs already run `close()`).
 *
 * `pagehide` only. A `visibilitychange` to hidden is a tab the user switched
 * away from, which still leads its database and still answers calls; announcing
 * a close there would tell every follower that a live leader had gone. The post
 * is synchronous: nothing asynchronous is guaranteed to run once the page is
 * unloading. It is a bare `postMessage` on a channel of this module's own. The
 * leader's serving channel is busy with calls, and a sender that receives
 * nothing cannot be confused with one.
 */
function announceOnPageHide(name: string, instance: string): () => void {
  const scope = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void
    removeEventListener?: (type: string, listener: () => void) => void
    BroadcastChannel?: typeof BroadcastChannel
  }

  if (scope.addEventListener === undefined || scope.BroadcastChannel === undefined) {
    return () => undefined
  }
  const Channel = scope.BroadcastChannel
  let channel: BroadcastChannel | null = null
  const announce = (): void => {
    channel ??= new Channel(SCOPE_PREFIX + name)
    channel.postMessage({ type: 'leader-closed', leader: instance } satisfies TLeaderResponse)
  }
  scope.addEventListener('pagehide', announce)

  return () => {
    scope.removeEventListener?.('pagehide', announce)
    channel?.close()
    channel = null
  }
}

/**
 * Elects this page leader or follower for `name`. Without `navigator.locks` (an
 * insecure context, or a browser too old) there is nothing to race on, so the page
 * takes the follower role and leads its own engine in the same breath: every tab is
 * single-tab, which is why the driver gives that engine a private memory store.
 */
export function electLeader(name: string, callbacks: ILeaderCallbacks): ILeaderElection {
  const locks = readLockManager()
  const instance = createTag()
  let role: TLeaderRole = 'follower'
  // Armed for as long as this page leads, so the goodbye is posted only by a page that had a database to give up.
  let stopAnnouncing: () => void = () => undefined

  if (locks === undefined) {
    // Run first here too, so a role is in place before this function returns and the page is never momentarily without one.
    callbacks.onFollower()
    role = 'leader'
    stopAnnouncing = announceOnPageHide(name, instance)
    // A synchronous throw is reported synchronously, not a microtask later: where no other tab can lead, a call made in this same tick has to be told the reason. It must not wait for a leader that cannot come. Either way the failure is reported and never escapes into the caller.
    let leading: Promise<void> = Promise.resolve()

    try {
      leading = Promise.resolve(callbacks.onLeader(instance))
    } catch (error) {
      role = 'follower'
      stopAnnouncing()
      callbacks.onLeaderFailed({ error, canAnotherTabLead: false })
    }
    const settled = leading.catch((error: unknown) => {
      role = 'follower'
      stopAnnouncing()
      callbacks.onLeaderFailed({ error, canAnotherTabLead: false })
    })

    return {
      get role(): TLeaderRole {
        return role
      },
      release: async (): Promise<void> => {
        stopAnnouncing()
        await settled
      },
    }
  }

  callbacks.onFollower()

  let released = false
  let resolveHold: () => void = () => undefined
  const hold = new Promise<void>((resolve) => {
    resolveHold = resolve
  })
  // Drops this page out of the queue on `release()`. It must not take a turn it no longer wants. Aborting after the grant is a no-op, so the `released` guard below still has to cover the grant that races the abort.
  const queued = new AbortController()

  const held = locks
    .request(SCOPE_PREFIX + name, { mode: 'exclusive', signal: queued.signal }, async () => {
      if (released) {
        return
      }
      role = 'leader'
      stopAnnouncing = announceOnPageHide(name, instance)

      try {
        await callbacks.onLeader(instance)
      } catch (error) {
        // Returning here releases the lock. The next tab gets a real turn; it does not wait behind a page that never opened the database.
        role = 'follower'
        stopAnnouncing()
        callbacks.onLeaderFailed({ error, canAnotherTabLead: true })

        return
      }
      await hold
    })
    .catch(() => undefined)

  return {
    get role(): TLeaderRole {
      return role
    },
    release: async (): Promise<void> => {
      released = true
      stopAnnouncing()
      queued.abort()
      resolveHold()

      // A page that never held the lock has no callback to settle: awaiting the request would wait for the current leader to go away.
      if (role === 'leader') {
        await held
      }
    },
  }
}
