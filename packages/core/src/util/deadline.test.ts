// MARK: - withDeadline

/**
 * Proves the deadline race in isolation, with injected fake timers so nothing
 * here waits on the wall clock: the run wins, the timer wins (and a late
 * settlement of the underlying promise never surfaces as an unhandled
 * rejection), `timeoutMs: 0` arms no timer, the timer is cleared once the run
 * settles first, and a synchronous throw from `run` still rejects.
 */

import { describe, expect, test } from 'bun:test'
import { createRequestSignal, withDeadline } from './deadline'

type TFakeTimer = { callback: () => void; delayMs: number; cleared: boolean }

/**
 * A recording setTimer/clearTimer pair: a spy without needing bun's
 * spyOn on a real global, since the pair is injected here, not ambient.
 */
const makeFakeTimers = () => {
  const armed: TFakeTimer[] = []
  const clearedHandles: unknown[] = []
  const setTimer = (callback: () => void, delayMs: number): unknown => {
    const handle: TFakeTimer = { callback, delayMs, cleared: false }

    armed.push(handle)

    return handle
  }
  const clearTimer = (handle: unknown): void => {
    clearedHandles.push(handle)
    ;(handle as TFakeTimer).cleared = true
  }
  const fire = (index = 0): void => {
    const handle = armed[index]

    if (handle === undefined || handle.cleared) {
      return
    }
    handle.callback()
  }
  return { setTimer, clearTimer, armed, clearedHandles, fire }
}

describe('withDeadline', () => {
  test('resolves when the run wins', async () => {
    const timers = makeFakeTimers()
    const result = await withDeadline(() => Promise.resolve('ok'), {
      timeoutMs: 50,
      onTimeout: () => new Error('should not fire'),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    expect(result).toBe('ok')
  })

  test('rejects with onTimeout() when the timer wins, and a late resolution is dropped without an unhandled rejection', async () => {
    const timers = makeFakeTimers()
    let resolveRun: ((value: string) => void) | undefined
    const run = (): Promise<string> => new Promise((resolve) => (resolveRun = resolve))
    const timeoutError = new Error('deadline blown')
    const promise = withDeadline(run, {
      timeoutMs: 10,
      onTimeout: () => timeoutError,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    timers.fire()
    await expect(promise).rejects.toBe(timeoutError)
    // Settles the underlying run after the deadline already won: must not throw or register as an unhandled rejection anywhere in the process.
    resolveRun?.('late')
    await Promise.resolve()
    await Promise.resolve()
  })

  test('rejects with onTimeout() when the timer wins, and a late rejection is dropped without an unhandled rejection', async () => {
    const timers = makeFakeTimers()
    let rejectRun: ((error: Error) => void) | undefined
    const run = (): Promise<string> => new Promise((_resolve, reject) => (rejectRun = reject))
    const timeoutError = new Error('deadline blown')
    const promise = withDeadline(run, {
      timeoutMs: 10,
      onTimeout: () => timeoutError,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    timers.fire()
    await expect(promise).rejects.toBe(timeoutError)
    rejectRun?.(new Error('late failure'))
    await Promise.resolve()
    await Promise.resolve()
  })

  test('timeoutMs 0 arms no timer and returns the run outcome', async () => {
    const timers = makeFakeTimers()
    const result = await withDeadline(() => Promise.resolve('untouched'), {
      timeoutMs: 0,
      onTimeout: () => new Error('should not fire'),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    expect(result).toBe('untouched')
    expect(timers.armed).toHaveLength(0)
  })

  test('the timer is cleared once the run settles first', async () => {
    const timers = makeFakeTimers()

    await withDeadline(() => Promise.resolve('ok'), {
      timeoutMs: 50,
      onTimeout: () => new Error('should not fire'),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    expect(timers.clearedHandles).toHaveLength(1)
    expect(timers.clearedHandles[0]).toBe(timers.armed[0])
  })

  test('a synchronous throw from run rejects', async () => {
    const timers = makeFakeTimers()
    const boom = new Error('boom')
    const run = (): Promise<string> => {
      throw boom
    }
    await expect(
      withDeadline(run, {
        timeoutMs: 50,
        onTimeout: () => new Error('should not fire'),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      }),
    ).rejects.toBe(boom)
    expect(timers.clearedHandles).toHaveLength(1)
  })
})

// MARK: - createRequestSignal

describe('createRequestSignal', () => {
  test('aborts on its own timer and reports timedOut', async () => {
    const { signal, timedOut, release } = createRequestSignal({ timeoutMs: 10 })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(signal.aborted).toBe(true)
    expect(timedOut()).toBe(true)
    release()
  })

  test('forwards a parent abort without reporting a timeout', () => {
    const parent = new AbortController()
    const { signal, timedOut, release } = createRequestSignal({ timeoutMs: 0, parentSignal: parent.signal })

    parent.abort()
    expect(signal.aborted).toBe(true)
    expect(timedOut()).toBe(false)
    release()
  })

  test('an already-aborted parent aborts the signal immediately, not as a timeout', () => {
    const parent = new AbortController()

    parent.abort()
    const { signal, timedOut, release } = createRequestSignal({ timeoutMs: 0, parentSignal: parent.signal })

    expect(signal.aborted).toBe(true)
    expect(timedOut()).toBe(false)
    release()
  })

  test('release clears the timer so it never fires', async () => {
    let fired = false
    const { release } = createRequestSignal({
      timeoutMs: 10,
      setTimer: (callback, delayMs) =>
        setTimeout(() => {
          fired = true
          callback()
        }, delayMs),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })

    release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fired).toBe(false)
  })

  test('timeoutMs <= 0 arms no timer', () => {
    const setTimer = (): never => {
      throw new Error('setTimer must not be called when the deadline is disabled')
    }
    expect(() => createRequestSignal({ timeoutMs: 0, setTimer })).not.toThrow()
  })
})
