/// <reference types="bun" />
/**
 * A client whose engine latched `identity_changed` resets and syncs once per
 * latch, unless the caller keeps queued writes and some are queued. A fake
 * client stands in; only its sync-health surface and outbox depth are under
 * test, and `reset` and `sync` are the caller's own.
 */

import { describe, expect, test } from 'bun:test'
import { ESoftBlockReason, ESyncPhase, type ISyncHealth, type TSoftBlockReason } from 'kizunasync'
import { resetOnIdentityChange } from './identity-recovery'

const IDLE_HEALTH: ISyncHealth = {
  phase: ESyncPhase.idle,
  consecutiveFailures: 0,
  nextAttemptAt: null,
  attemptStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
  softBlockReason: null,
}

const healthBlockedBy = (reason: TSoftBlockReason | null): ISyncHealth => ({ ...IDLE_HEALTH, softBlockReason: reason })

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface IFakeOptions {
  initial?: TSoftBlockReason | null
  outboxDepth?: number
  resetError?: string
  keepQueuedWrites?: boolean
}

const watch = (options: IFakeOptions = {}) => {
  const listeners = new Set<(health: ISyncHealth) => void>()
  const calls: string[] = []
  const failures: unknown[] = []
  let releaseReset: () => void = () => undefined
  const resetGate = new Promise<void>((resolve) => {
    releaseReset = resolve
  })
  let holdsReset = false

  const unsubscribe = resetOnIdentityChange({
    client: {
      getSyncHealth: () => healthBlockedBy(options.initial ?? null),
      onSyncHealth: (listener) => {
        listeners.add(listener)

        return () => {
          listeners.delete(listener)
        }
      },
      getOutboxDepth: () => {
        calls.push('getOutboxDepth')

        return Promise.resolve(options.outboxDepth ?? 0)
      },
    },
    reset: async () => {
      calls.push('reset')

      if (holdsReset) {
        await resetGate
      }
      if (options.resetError !== undefined) {
        throw new Error(options.resetError)
      }
    },
    sync: () => {
      calls.push('sync')

      return Promise.resolve()
    },
    keepQueuedWrites: options.keepQueuedWrites ?? false,
    onRecovered: () => {
      calls.push('onRecovered')
    },
    onFailed: (cause) => {
      failures.push(cause)
    },
  })

  return {
    calls,
    failures,
    unsubscribe,
    emit: (reason: TSoftBlockReason | null) => {
      for (const listener of [...listeners]) {
        listener(healthBlockedBy(reason))
      }
    },
    holdReset: () => {
      holdsReset = true
    },
    releaseReset: () => {
      releaseReset()
    },
    listenerCount: () => listeners.size,
  }
}

describe('resetOnIdentityChange', () => {
  test('an identity_changed latch resets, then syncs, then reports the recovery', async () => {
    const watched = watch()

    watched.emit(ESoftBlockReason.identityChanged)
    await settle()

    expect(watched.calls).toEqual(['reset', 'sync', 'onRecovered'])
    expect(watched.failures).toEqual([])
  })

  test('a client already latched when the watch starts recovers without waiting for the next health event', async () => {
    const watched = watch({ initial: ESoftBlockReason.identityChanged })

    await settle()

    expect(watched.calls).toEqual(['reset', 'sync', 'onRecovered'])
  })

  test('a second latch heard while the first recovery runs starts no second recovery', async () => {
    const watched = watch()

    watched.holdReset()
    watched.emit(ESoftBlockReason.identityChanged)
    watched.emit(ESoftBlockReason.identityChanged)
    await settle()
    watched.releaseReset()
    await settle()

    expect(watched.calls).toEqual(['reset', 'sync', 'onRecovered'])
  })

  test('a reset_required block is left to the app', async () => {
    const watched = watch({ initial: ESoftBlockReason.resetRequired })

    watched.emit(ESoftBlockReason.resetRequired)
    await settle()

    expect(watched.calls).toEqual([])
    expect(watched.failures).toEqual([])
  })

  test('a failing reset reaches onFailed instead of throwing, and skips the sync', async () => {
    const watched = watch({ resetError: 'store is locked' })

    watched.emit(ESoftBlockReason.identityChanged)
    await settle()

    expect(watched.calls).toEqual(['reset'])
    expect(watched.failures.map((cause) => (cause instanceof Error ? cause.message : cause))).toEqual(['store is locked'])
  })

  test('the returned function stops the watch', async () => {
    const watched = watch()

    watched.unsubscribe()
    watched.emit(ESoftBlockReason.identityChanged)
    await settle()

    expect(watched.listenerCount()).toBe(0)
    expect(watched.calls).toEqual([])
  })

  test('keepQueuedWrites leaves the block in place while writes are queued', async () => {
    const watched = watch({ keepQueuedWrites: true, outboxDepth: 2 })

    watched.emit(ESoftBlockReason.identityChanged)
    await settle()

    expect(watched.calls).toEqual(['getOutboxDepth'])
    expect(watched.failures).toEqual([])
  })

  test('keepQueuedWrites with an empty outbox resets and syncs once', async () => {
    const watched = watch({ keepQueuedWrites: true, outboxDepth: 0 })

    watched.emit(ESoftBlockReason.identityChanged)
    await settle()

    expect(watched.calls).toEqual(['getOutboxDepth', 'reset', 'sync', 'onRecovered'])
  })
})
