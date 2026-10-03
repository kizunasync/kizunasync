// MARK: - useSyncStatus

/**
 * Mirrors use-rejections.test.tsx: a fake IKizunaSync plus a Probe component that
 * reassigns a captured `latest` reference on every render, so the test asserts
 * on the hook's return value directly. The health surface is what is under test
 * here; the outbox/checkpoint half is already covered by the reads the fake
 * answers with constants.
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act, render } from '@testing-library/react'
import { alwaysOnline, ESoftBlockReason, ESyncPhase, INITIAL_CHECKPOINT_STATE, type IConnectivity, type IKizunaSync, type ISyncHealth, type TCheckpointState } from '@kizunasync/core'
import { useSyncStatus, type ISyncStatusResult } from './use-sync-status'

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

const makeClient = (
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

let latest: ISyncStatusResult | undefined

function Probe({ client, connectivity }: { client: IKizunaSync; connectivity?: IConnectivity }): React.ReactElement {
  latest = useSyncStatus({ client, connectivity })

  return React.createElement('div', null, latest.health.phase)
}

describe('useSyncStatus health', () => {
  test('reads the current health on mount', async () => {
    const { client } = makeClient(IDLE)

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.health.phase).toBe(ESyncPhase.idle)
    expect(latest?.isStalled).toBe(false)
    expect(latest?.nextRetryAt).toBe(15_000)
  })

  test('re-renders on every published transition', async () => {
    const { client, emit } = makeClient(IDLE)

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })

    await act(async () => {
      emit(STALLED)
    })
    expect(latest?.health.phase).toBe(ESyncPhase.stalled)
    expect(latest?.isStalled).toBe(true)
    expect(latest?.nextRetryAt).toBe(45_000)
    expect(latest?.health.consecutiveFailures).toBe(1)
  })

  test('a failure surfaces its code without touching lastError', async () => {
    const { client, emit } = makeClient(IDLE)

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })

    await act(async () => {
      emit({
        ...IDLE,
        phase: ESyncPhase.backoff,
        consecutiveFailures: 2,
        lastError: { code: 'AUTH_SESSION_TIMEOUT', message: 'the session timed out', at: 20_000 },
      })
    })
    expect(latest?.health.lastError?.code).toBe('AUTH_SESSION_TIMEOUT')
    // lastError stays the syncNow / verdict channel: the loop's own failures are diagnostics, not something to raise at the user as an action error.
    expect(latest?.lastError).toBeNull()
  })

  test('unmounting unsubscribes from the loop', async () => {
    const { client, listeners } = makeClient(IDLE)
    let unmount!: () => void

    await act(async () => {
      unmount = render(React.createElement(Probe, { client })).unmount
    })
    expect(listeners()).toBe(1)

    await act(async () => {
      unmount()
    })
    expect(listeners()).toBe(0)
  })
})

// MARK: - The reset signal

/**
 * A fake whose checkpoint reports the soft block. `needsReset` is derived from
 * the checkpoint, never from the event that caused it.
 */
const makeBlockedClient = (softBlocked: boolean): IKizunaSync =>
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
    await act(async () => {
      render(React.createElement(Probe, { client: makeBlockedClient(false) }))
    })
    expect(latest?.needsReset).toBe(false)
  })

  test('needsReset follows checkpoint.softBlocked', async () => {
    await act(async () => {
      render(React.createElement(Probe, { client: makeBlockedClient(true) }))
    })
    expect(latest?.needsReset).toBe(true)
    expect(latest?.checkpoint.softBlocked).toBe(true)
  })

})

// MARK: - The soft-block reason

/**
 * The reason is read from the health snapshot the engine publishes, never from
 * a checkpoint read: a checkpoint that names one while the snapshot does not
 * leaves the hook at null.
 */
describe('useSyncStatus soft-block reason', () => {
  const blockedCheckpointClient = (health: ISyncHealth): { client: IKizunaSync; emit: (health: ISyncHealth) => void } => {
    const fake = makeClient(health)
    const client = {
      ...fake.client,
      getCheckpoint: (): Promise<TCheckpointState> =>
        Promise.resolve({ ...INITIAL_CHECKPOINT_STATE, softBlocked: true, softBlockReason: ESoftBlockReason.resetRequired }),
    } as unknown as IKizunaSync

    return { client, emit: fake.emit }
  }

  test('softBlockReason is null while the health snapshot names none, whatever the checkpoint says', async () => {
    const { client } = blockedCheckpointClient(IDLE)

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.needsReset).toBe(true)
    expect(latest?.softBlockReason).toBeNull()
  })

  test.each([ESoftBlockReason.resetRequired, ESoftBlockReason.identityChanged])(
    'softBlockReason follows the health snapshot reason %s',
    async (reason) => {
      const { client } = makeClient({ ...IDLE, softBlockReason: reason })

      await act(async () => {
        render(React.createElement(Probe, { client }))
      })
      expect(latest?.softBlockReason).toBe(reason)
    },
  )

  test('softBlockReason follows a published health transition', async () => {
    const { client, emit } = blockedCheckpointClient(IDLE)

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })

    await act(async () => {
      emit({ ...IDLE, softBlockReason: ESoftBlockReason.identityChanged })
    })
    expect(latest?.softBlockReason).toBe(ESoftBlockReason.identityChanged)

    await act(async () => {
      emit({ ...IDLE, softBlockReason: null })
    })
    expect(latest?.softBlockReason).toBeNull()
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
  test('follows the app client connectivity when no connectivity option is passed', async () => {
    const network = makeNetwork(false)
    const client = { ...makeClient(IDLE).client, connectivity: network.port } as IKizunaSync

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.isOnline).toBe(false)

    await act(async () => {
      network.switchTo(true)
    })
    expect(latest?.isOnline).toBe(true)
  })

  test('an explicit connectivity option wins over the app client one', async () => {
    const clientNetwork = makeNetwork(false)
    const optionNetwork = makeNetwork(true)
    const client = { ...makeClient(IDLE).client, connectivity: clientNetwork.port } as IKizunaSync

    await act(async () => {
      render(React.createElement(Probe, { client, connectivity: optionNetwork.port }))
    })
    expect(latest?.isOnline).toBe(true)
    expect(optionNetwork.listeners()).toBe(1)
    expect(clientNetwork.listeners()).toBe(0)
  })
})
