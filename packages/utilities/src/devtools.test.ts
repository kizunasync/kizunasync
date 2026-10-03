/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { createKizunaSync, defineConfig, type IConnectivity, type IKizunaSync, type IStoreLocator, type IWakeup } from 'kizunasync'
import { createConnectivityGate, createGatedWakeup, createLiveSyncGate } from './devtools'

// MARK: - Fixtures

/** A connectivity whose online value and transitions the test drives. */
const fakeConnectivity = (initial: boolean) => {
  let online = initial
  const listeners = new Set<(online: boolean) => void>()

  return {
    port: {
      isOnline: () => online,
      subscribe: (onChange: (online: boolean) => void) => {
        listeners.add(onChange)

        return () => {
          listeners.delete(onChange)
        }
      },
    } satisfies IConnectivity,
    emit: (next: boolean) => {
      online = next

      for (const listener of listeners) {
        listener(next)
      }
    },
    set: (next: boolean) => {
      online = next
    },
  }
}

// MARK: - Live-sync gate

describe('createLiveSyncGate', () => {
  test('starts live and online', () => {
    const gate = createLiveSyncGate()

    expect(gate.isActive()).toBe(true)
    expect(gate.isLiveSyncEnabled()).toBe(true)
    expect(gate.isOfflineSimulated()).toBe(false)
  })

  test('offline wins over the live-sync toggle', () => {
    const gate = createLiveSyncGate()

    gate.setOffline(true)
    expect(gate.isActive()).toBe(false)
    gate.setLiveSync(true)
    expect(gate.isActive()).toBe(false)
    gate.setOffline(false)
    expect(gate.isActive()).toBe(true)
  })

  test('the offline switch publishes the resulting online value', () => {
    const gate = createLiveSyncGate()
    const seen: boolean[] = []

    gate.subscribeOnline((online) => seen.push(online))
    gate.setOffline(true)
    gate.setOffline(false)
    expect(seen).toEqual([false, true])
  })

  test('both flags notify the active subscribers', () => {
    const gate = createLiveSyncGate()
    let reconciles = 0
    const stop = gate.subscribeActive(() => {
      reconciles += 1
    })

    gate.setLiveSync(false)
    gate.setOffline(true)
    expect(reconciles).toBe(2)
    stop()
    gate.setLiveSync(true)
    expect(reconciles).toBe(2)
  })

  test('an unchanged flag notifies nobody', () => {
    const gate = createLiveSyncGate()
    let reconciles = 0

    gate.subscribeActive(() => {
      reconciles += 1
    })
    gate.setLiveSync(true)
    gate.setOffline(false)
    expect(reconciles).toBe(0)
  })
})

// MARK: - Connectivity gate

describe('createConnectivityGate', () => {
  test('reports offline while the switch is on, whatever the device says', () => {
    const device = fakeConnectivity(true)
    const gate = createLiveSyncGate()
    const connectivity = createConnectivityGate({ inner: device.port, gate })

    expect(connectivity.isOnline()).toBe(true)
    gate.setOffline(true)
    expect(connectivity.isOnline()).toBe(false)
  })

  test('forwards real transitions only while live sync is active', () => {
    const device = fakeConnectivity(true)
    const gate = createLiveSyncGate()
    const connectivity = createConnectivityGate({ inner: device.port, gate })
    const seen: boolean[] = []

    connectivity.subscribe((online) => seen.push(online))

    device.emit(false)
    gate.setLiveSync(false)
    device.emit(true)
    expect(seen).toEqual([false])
  })

  test('releasing the switch reports what isOnline reports, not a blind true', () => {
    const device = fakeConnectivity(true)
    const gate = createLiveSyncGate()
    const connectivity = createConnectivityGate({ inner: device.port, gate })
    const seen: boolean[] = []

    connectivity.subscribe((online) => seen.push(online))

    gate.setOffline(true)
    device.set(false)
    gate.setOffline(false)
    expect(seen).toEqual([false, false])
    expect(connectivity.isOnline()).toBe(false)
  })

  test('unsubscribing releases both the gate and the device', () => {
    const device = fakeConnectivity(true)
    const gate = createLiveSyncGate()
    const connectivity = createConnectivityGate({ inner: device.port, gate })
    const seen: boolean[] = []
    const stop = connectivity.subscribe((online) => seen.push(online))

    stop()
    gate.setOffline(true)
    gate.setLiveSync(false)
    gate.setLiveSync(true)
    device.emit(false)
    expect(seen).toEqual([])
  })

  test('turning live sync back on reports the current value once, which is what wakes the engine', () => {
    const device = fakeConnectivity(true)
    const gate = createLiveSyncGate()
    const connectivity = createConnectivityGate({ inner: device.port, gate })
    const seen: boolean[] = []

    connectivity.subscribe((online) => seen.push(online))

    gate.setLiveSync(false)
    expect(seen).toEqual([])

    gate.setLiveSync(true)
    expect(seen).toEqual([true])
  })

  test('turning live sync back on over a dead network reports that the device is offline', () => {
    const device = fakeConnectivity(true)
    const gate = createLiveSyncGate()
    const connectivity = createConnectivityGate({ inner: device.port, gate })
    const seen: boolean[] = []

    connectivity.subscribe((online) => seen.push(online))

    gate.setLiveSync(false)
    device.emit(false)
    gate.setLiveSync(true)
    expect(seen).toEqual([false])
  })

  test('turning live sync back on under simulated offline reports nothing until the switch is released', () => {
    const device = fakeConnectivity(true)
    const gate = createLiveSyncGate()
    const connectivity = createConnectivityGate({ inner: device.port, gate })
    const seen: boolean[] = []

    connectivity.subscribe((online) => seen.push(online))

    gate.setOffline(true)
    gate.setLiveSync(false)
    gate.setLiveSync(true)
    expect(seen).toEqual([false])

    gate.setOffline(false)
    expect(seen).toEqual([false, true])
  })
})

// MARK: - Wakeup gate

/** A doorbell that reports how many times it has been subscribed and torn down. */
const fakeWakeup = () => {
  let onSignal: (() => void) | null = null
  const opened: number[] = []

  return {
    port: {
      subscribe: (listener: () => void) => {
        opened.push(1)
        onSignal = listener

        return () => {
          onSignal = null
        }
      },
    } satisfies IWakeup,
    isOpen: () => onSignal !== null,
    openCount: () => opened.length,
    ring: () => onSignal?.(),
  }
}

describe('createGatedWakeup', () => {
  test('opens the channel while active and tears it down when the gate closes', () => {
    const doorbell = fakeWakeup()
    const gate = createLiveSyncGate()
    const stop = createGatedWakeup({ inner: doorbell.port, gate }).subscribe(() => undefined)

    expect(doorbell.isOpen()).toBe(true)
    gate.setOffline(true)
    expect(doorbell.isOpen()).toBe(false)
    gate.setOffline(false)
    expect(doorbell.isOpen()).toBe(true)
    expect(doorbell.openCount()).toBe(2)
    stop()
  })

  test('starts closed when the gate is already inactive', () => {
    const doorbell = fakeWakeup()
    const gate = createLiveSyncGate()

    gate.setLiveSync(false)
    const stop = createGatedWakeup({ inner: doorbell.port, gate }).subscribe(() => undefined)

    expect(doorbell.isOpen()).toBe(false)
    expect(doorbell.openCount()).toBe(0)
    stop()
  })

  test('forwards a ring only while active', () => {
    const doorbell = fakeWakeup()
    const gate = createLiveSyncGate()
    let signals = 0
    const stop = createGatedWakeup({ inner: doorbell.port, gate }).subscribe(() => {
      signals += 1
    })

    doorbell.ring()
    expect(signals).toBe(1)
    gate.setLiveSync(false)
    doorbell.ring()
    expect(signals).toBe(1)
    stop()
  })

  test('unsubscribing closes the channel and stops reconciling', () => {
    const doorbell = fakeWakeup()
    const gate = createLiveSyncGate()
    const stop = createGatedWakeup({ inner: doorbell.port, gate }).subscribe(() => undefined)

    stop()
    expect(doorbell.isOpen()).toBe(false)
    gate.setOffline(true)
    gate.setOffline(false)
    expect(doorbell.openCount()).toBe(1)
  })
})

// MARK: - The gate in front of an app client

type TGatedClient = {
  client: IKizunaSync

  /** How many `sync` calls reached the engine. */
  syncs: () => number

  /** Hands the client an engine event, as the engine would after a local write. */
  emit: (eventJson: string) => void

  /** Runs every timer the client armed so far. */
  fire: () => Promise<void>

  armed: () => number
}

/**
 * An app client wired the way the examples wire it: the gated connectivity, and
 * `shouldSyncAutomatically` answered by the gate. The engine is a transport that
 * answers every call, so the loop is what is under test.
 */
const gatedClient = (gate: ReturnType<typeof createLiveSyncGate>): TGatedClient => {
  const calls: string[] = []
  const pending = new Map<number, () => void>()
  let nextHandle = 0
  let onEngineEvent: (eventJson: string) => void = () => undefined
  const locator: IStoreLocator = {
    databasePath: null,
    engineTransport: (_configJson, _databasePath, _pull, _push, onEvent) => {
      onEngineEvent = onEvent

      return {
        call: async (method) => {
          calls.push(method)

          return JSON.stringify({ ok: true, value: method === 'checkpoint' ? { cursor: '0', soft_blocked: false } : null })
        },
        close: () => undefined,
      }
    },
  }
  const client = createKizunaSync(
    locator,
    { pull: () => Promise.reject(new Error('unused')), push: () => Promise.reject(new Error('unused')) },
    defineConfig({ tables: { todos: { sync: 'read-write' } } }),
    {
      inspector: false,
      pollIntervalMs: 0,
      connectivity: createConnectivityGate({ inner: fakeConnectivity(true).port, gate }),
      shouldSyncAutomatically: () => gate.isActive(),
      setTimer: (callback) => {
        nextHandle += 1
        pending.set(nextHandle, callback)

        return nextHandle
      },
      clearTimer: (handle) => {
        pending.delete(handle as number)
      },
    },
  )

  return {
    client,
    syncs: () => calls.filter((method) => method === 'sync').length,
    emit: (eventJson) => onEngineEvent(eventJson),
    fire: async () => {
      const due = [...pending.values()]

      pending.clear()

      for (const callback of due) {
        callback()
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    armed: () => pending.size,
  }
}

describe('the live-sync gate in front of an app client', () => {
  test('with live sync off a local write syncs nothing, sync now still runs, and turning it back on syncs once', async () => {
    const gate = createLiveSyncGate()
    const run = gatedClient(gate)

    gate.setLiveSync(false)
    run.emit('{"type":"QUEUE_DEPTH","depth":1}')
    expect(run.armed()).toBe(0)

    await run.client.sync()
    expect(run.syncs()).toBe(1)

    gate.setLiveSync(true)
    expect(run.armed()).toBe(1)

    await run.fire()
    expect(run.syncs()).toBe(2)
    expect(run.armed()).toBe(0)
    run.client.dispose()
  })
})
