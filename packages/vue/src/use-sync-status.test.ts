/// <reference types="bun" />
/**
 * Mirrors use-rejections.test.ts: the composable runs inside an effectScope so
 * onScopeDispose fires deterministically (no component instance), and a fake
 * IKizunaSync publishes sync-loop transitions without a real engine. The health
 * surface is what is under test; the outbox/checkpoint half is answered with
 * constants.
 */
// MARK: - useSyncStatus

import { describe, expect, test } from 'bun:test'
import { effectScope } from 'vue'
import { alwaysOnline, ESoftBlockReason, ESyncPhase, INITIAL_CHECKPOINT_STATE, type IConnectivity, type IKizunaSync, type ISyncHealth, type TCheckpointState } from '@kizunasync/core'
import { useSyncStatus } from './use-sync-status'

const IDLE: ISyncHealth = {
  phase: ESyncPhase.idle,
  consecutiveFailures: 0,
  nextAttemptAt: 15_000,
  attemptStartedAt: null,
  lastSuccessAt: 1_000,
  lastError: null,
}

const STALLED: ISyncHealth = {
  phase: ESyncPhase.stalled,
  consecutiveFailures: 1,
  nextAttemptAt: 45_000,
  attemptStartedAt: 12_000,
  lastSuccessAt: 1_000,
  lastError: null,
}

const makeFakeKizunaSync = (
  initial: ISyncHealth,
): {
  client: IKizunaSync
  emit: (health: ISyncHealth) => void
  listeners: () => number
} => {
  const listeners = new Set<(health: ISyncHealth) => void>()
  const client = {
    on: () => () => undefined,
    getOutboxDepth: () => Promise.resolve(0),
    getCheckpoint: () => Promise.resolve(INITIAL_CHECKPOINT_STATE),
    sync: () => Promise.resolve(),
    connectivity: alwaysOnline,
    getSyncHealth: () => initial,
    onSyncHealth: (listener: (health: ISyncHealth) => void) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
  } as unknown as IKizunaSync

  return {
    client,
    emit: (health) => listeners.forEach((listener) => listener(health)),
    listeners: () => listeners.size,
  }
}

describe('useSyncStatus health', () => {
  test('reads the current health when the scope starts', () => {
    const { client } = makeFakeKizunaSync(IDLE)
    const scope = effectScope()
    let result!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      result = useSyncStatus({ client })
    })
    expect(result.health.value.phase).toBe(ESyncPhase.idle)
    expect(result.isStalled.value).toBe(false)
    expect(result.nextRetryAt.value).toBe(15_000)
    scope.stop()
  })

  test('every published transition updates the refs', () => {
    const { client, emit } = makeFakeKizunaSync(IDLE)
    const scope = effectScope()
    let result!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      result = useSyncStatus({ client })
    })

    emit(STALLED)
    expect(result.health.value.phase).toBe(ESyncPhase.stalled)
    expect(result.isStalled.value).toBe(true)
    expect(result.nextRetryAt.value).toBe(45_000)
    expect(result.health.value.consecutiveFailures).toBe(1)
    scope.stop()
  })

  test('a failure surfaces its code without touching lastError', () => {
    const { client, emit } = makeFakeKizunaSync(IDLE)
    const scope = effectScope()
    let result!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      result = useSyncStatus({ client })
    })

    emit({
      ...IDLE,
      phase: ESyncPhase.backoff,
      consecutiveFailures: 2,
      lastError: { code: 'AUTH_SESSION_TIMEOUT', message: 'the session timed out', at: 20_000 },
    })
    expect(result.health.value.lastError?.code).toBe('AUTH_SESSION_TIMEOUT')
    // lastError stays the syncNow / verdict channel: the loop's own failures are diagnostics, not something to raise at the user as an action error.
    expect(result.lastError.value).toBeNull()
    scope.stop()
  })

  test('stopping the scope unsubscribes from the loop', () => {
    const { client, listeners } = makeFakeKizunaSync(IDLE)
    const scope = effectScope()

    scope.run(() => {
      useSyncStatus({ client })
    })
    expect(listeners()).toBe(1)

    scope.stop()
    expect(listeners()).toBe(0)
  })
})

// MARK: - The reset signal

/**
 * A fake whose checkpoint reports the soft block. `needsReset` is derived from
 * the checkpoint, never from the event that caused it.
 */
const makeBlockedKizunaSync = (softBlocked: boolean): IKizunaSync =>
  ({
    on: () => () => undefined,
    getOutboxDepth: () => Promise.resolve(3),
    getCheckpoint: (): Promise<TCheckpointState> => Promise.resolve({ ...INITIAL_CHECKPOINT_STATE, softBlocked }),
    sync: () => Promise.resolve(),
    connectivity: alwaysOnline,
    getSyncHealth: () => IDLE,
    onSyncHealth: () => () => undefined,
  }) as unknown as IKizunaSync

describe('useSyncStatus reset signal', () => {
  test('needsReset is false while the checkpoint is not soft-blocked', async () => {
    const scope = effectScope()
    let result!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      result = useSyncStatus({ client: makeBlockedKizunaSync(false) })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.needsReset.value).toBe(false)
    scope.stop()
  })

  test('needsReset follows checkpoint.softBlocked', async () => {
    const scope = effectScope()
    let result!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      result = useSyncStatus({ client: makeBlockedKizunaSync(true) })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.needsReset.value).toBe(true)
    expect(result.checkpoint.value.softBlocked).toBe(true)
    scope.stop()
  })

})

// MARK: - The soft-block reason

/**
 * The reason is read from the health snapshot the engine publishes, never from
 * a checkpoint read: a checkpoint that names one while the snapshot does not
 * leaves the composable at null.
 */
describe('useSyncStatus soft-block reason', () => {
  const blockedCheckpointClient = (health: ISyncHealth): { client: IKizunaSync; emit: (health: ISyncHealth) => void } => {
    const fake = makeFakeKizunaSync(health)
    const client = {
      ...fake.client,
      getCheckpoint: (): Promise<TCheckpointState> =>
        Promise.resolve({ ...INITIAL_CHECKPOINT_STATE, softBlocked: true, softBlockReason: ESoftBlockReason.resetRequired }),
    } as unknown as IKizunaSync

    return { client, emit: fake.emit }
  }

  test('softBlockReason is null while the health snapshot names none, whatever the checkpoint says', async () => {
    const scope = effectScope()
    let result!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      result = useSyncStatus({ client: blockedCheckpointClient(IDLE).client })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.needsReset.value).toBe(true)
    expect(result.softBlockReason.value).toBeNull()
    scope.stop()
  })

  test.each([ESoftBlockReason.resetRequired, ESoftBlockReason.identityChanged])(
    'softBlockReason follows the health snapshot reason %s',
    (reason) => {
      const scope = effectScope()
      let result!: ReturnType<typeof useSyncStatus>

      scope.run(() => {
        result = useSyncStatus({ client: makeFakeKizunaSync({ ...IDLE, softBlockReason: reason }).client })
      })
      expect(result.softBlockReason.value).toBe(reason)
      scope.stop()
    },
  )

  test('softBlockReason follows a published health transition', () => {
    const { client, emit } = blockedCheckpointClient(IDLE)
    const scope = effectScope()
    let result!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      result = useSyncStatus({ client })
    })

    emit({ ...IDLE, softBlockReason: ESoftBlockReason.identityChanged })
    expect(result.softBlockReason.value).toBe(ESoftBlockReason.identityChanged)

    emit({ ...IDLE, softBlockReason: null })
    expect(result.softBlockReason.value).toBeNull()
    scope.stop()
  })
})

// MARK: - Connectivity

/** A network signal the test switches by hand, counting who listens to it. */
const makeNetwork = (initial: boolean): { port: IConnectivity; switchTo: (online: boolean) => void; listeners: () => number } => {
  let online = initial
  const listeners = new Set<(online: boolean) => void>()

  return {
    port: {
      isOnline: () => online,
      subscribe: (onChange) => {
        listeners.add(onChange)

        return () => {
          listeners.delete(onChange)
        }
      },
    },
    switchTo: (next) => {
      online = next
      listeners.forEach((listener) => listener(next))
    },
    listeners: () => listeners.size,
  }
}

describe('useSyncStatus connectivity', () => {
  test('follows the app client connectivity when no connectivity option is passed', () => {
    const network = makeNetwork(false)
    const client = { ...makeFakeKizunaSync(IDLE).client, connectivity: network.port } as IKizunaSync
    const scope = effectScope()
    let result!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      result = useSyncStatus({ client })
    })
    expect(result.isOnline.value).toBe(false)

    network.switchTo(true)
    expect(result.isOnline.value).toBe(true)

    scope.stop()
    expect(network.listeners()).toBe(0)
  })

  test('an explicit connectivity option wins over the app client one', () => {
    const clientNetwork = makeNetwork(false)
    const optionNetwork = makeNetwork(true)
    const client = { ...makeFakeKizunaSync(IDLE).client, connectivity: clientNetwork.port } as IKizunaSync
    const scope = effectScope()
    let result!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      result = useSyncStatus({ client, connectivity: optionNetwork.port })
    })
    expect(result.isOnline.value).toBe(true)
    expect(optionNetwork.listeners()).toBe(1)
    expect(clientNetwork.listeners()).toBe(0)
    scope.stop()
  })
})
