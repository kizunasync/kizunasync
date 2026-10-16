import { describe, expect, test } from 'bun:test'
import { createExpoEngineHandle } from './native-engine'
import type { IKizunaExpoModule } from './native-module.types'

function harness() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const opening = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  const listeners = new Set<(payload: string) => void>()
  let id = ''
  let closed = 0
  let calls = 0
  const module: IKizunaExpoModule = {
    newEngineId: () => crypto.randomUUID(),
    databasePath: (name) => `/SQLite/${name}`,
    createEngine: (engineId) => {
      id = engineId

      return opening
    },
    call: () => {
      calls += 1

      return 'sync'
    },
    callAsync: async () => {
      calls += 1

      return 'async'
    },
    closeEngine: async () => {
      closed += 1
    },
    addListener: (_name, callback) => {
      listeners.add(callback)

      return {
        remove: () => {
          listeners.delete(callback)
        },
      }
    },
  }

  return {
    module,
    resolve,
    reject,
    emit: (engineId = id) => {
      for (const callback of listeners)
        callback(
          JSON.stringify({ id: engineId, event: { tag: 'LocalChanged' } }),
        )
    },
    counts: () => ({ closed, calls, listeners: listeners.size }),
  }
}

describe('Expo engine lifetime and event delivery', () => {
  test('uses native ids to isolate engines across JS module reloads and runtimes', async () => {
    const native = harness()
    let allocated = 0

    native.module.newEngineId = () => `native:${++allocated}`
    const first = createExpoEngineHandle(native.module)
    const second = createExpoEngineHandle(native.module)
    const seen: string[] = []

    first.create('{}')
    second.create('{}')
    first.subscribe({ onEvent: () => { seen.push('first') } })
    second.subscribe({ onEvent: () => { seen.push('second') } })
    native.emit('native:1')
    native.emit('native:2')
    expect(allocated).toBe(2)
    expect(seen).toEqual(['first', 'second'])
    native.resolve()
    first.shutdown()
    second.shutdown()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(native.counts()).toEqual({ closed: 2, calls: 0, listeners: 0 })
  })
  test('awaits native initialization before an async RPC and rejects early synchronous RPCs', async () => {
    const native = harness()
    const engine = createExpoEngineHandle(native.module)

    engine.create('{}')
    const response = engine.callAsync('ping', '{}')

    expect(native.counts().calls).toBe(0)
    expect(() => engine.call('ping', '{}')).toThrow(
      'before Expo engine readiness',
    )
    native.resolve()
    expect(await response).toBe('async')
    expect(engine.call('ping', '{}')).toBe('sync')
    engine.shutdown()
    await Promise.resolve()
    expect(native.counts()).toEqual({ closed: 1, calls: 2, listeners: 0 })
  })

  test('isolates engines and failing observers, and permits unsubscribe during delivery', async () => {
    const native = harness()
    const engine = createExpoEngineHandle(native.module)
    const received: string[] = []

    engine.create('{}')
    engine.subscribe({
      onEvent: () => {
        throw new Error('observer failure')
      },
    })
    const subscription = engine.subscribe({
      onEvent: (event) => {
        received.push(event.tag)
        engine.unsubscribe(subscription)
      },
    })

    expect(typeof subscription).toBe('bigint')
    native.emit('unrelated engine')
    expect(received).toEqual([])
    native.emit()
    native.emit()
    expect(received).toEqual(['LocalChanged'])
    engine.shutdown()
    native.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    native.emit()
    expect(native.counts().closed).toBe(1)
    expect(native.counts().listeners).toBe(0)
  })

  test('preserves native open errors on every call', async () => {
    const native = harness()
    const engine = createExpoEngineHandle(native.module)

    engine.create('{}')
    native.reject(
      new Error('STORE_BUSY: pending migration belongs to another process'),
    )
    await expect(engine.callAsync('ping', '{}')).rejects.toThrow('STORE_BUSY')
    await expect(engine.callAsync('ping', '{}')).rejects.toThrow('STORE_BUSY')
    engine.shutdown()
    expect(native.counts().calls).toBe(0)
    expect(native.counts().listeners).toBe(0)
  })

  test('closing during initialization prevents queued calls and closes the eventual native engine once', async () => {
    const native = harness()
    const engine = createExpoEngineHandle(native.module)

    engine.create('{}')
    const response = engine.callAsync('ping', '{}')

    engine.shutdown()
    engine.shutdown()
    native.resolve()
    await expect(response).rejects.toThrow('closed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(native.counts()).toEqual({ closed: 1, calls: 0, listeners: 0 })
  })
})
