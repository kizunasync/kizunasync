import { beforeEach, describe, expect, test } from 'bun:test'
import { consumeRateLimit, MAX_TRACKED_KEYS, rateLimitTrackedKeyCountForTests, resetRateLimitForTests } from './rate-limit'

/** Filling MAX_TRACKED_KEYS keys sweeps the whole map on every call, so this case is quadratic in the cap and outlasts Bun's 5 s default on slow CI runners. */
const CAP_CASE_TIMEOUT_MS = 30_000

describe('consumeRateLimit', () => {
  beforeEach(() => {
    resetRateLimitForTests()
  })

  test('allows requests up to the limit within the window', async () => {
    const key = 'test:within-limit'

    expect(await consumeRateLimit(key, 60_000, 3)).toBe(true)
    expect(await consumeRateLimit(key, 60_000, 3)).toBe(true)
    expect(await consumeRateLimit(key, 60_000, 3)).toBe(true)
  })

  test('rejects once the limit is exceeded within the window', async () => {
    const key = 'test:exceeds-limit'

    expect(await consumeRateLimit(key, 60_000, 2)).toBe(true)
    expect(await consumeRateLimit(key, 60_000, 2)).toBe(true)
    expect(await consumeRateLimit(key, 60_000, 2)).toBe(false)
  })

  test('keeps distinct keys in separate buckets', async () => {
    expect(await consumeRateLimit('test:key-a', 60_000, 1)).toBe(true)
    expect(await consumeRateLimit('test:key-b', 60_000, 1)).toBe(true)
    expect(await consumeRateLimit('test:key-a', 60_000, 1)).toBe(false)
  })

  test('allows again once the window has elapsed', async () => {
    const key = 'test:window-expiry'

    expect(await consumeRateLimit(key, 40, 1)).toBe(true)
    expect(await consumeRateLimit(key, 40, 1)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(await consumeRateLimit(key, 40, 1)).toBe(true)
  })

  test('resetRateLimitForTests clears every bucket', async () => {
    const key = 'test:reset'

    expect(await consumeRateLimit(key, 60_000, 1)).toBe(true)
    expect(await consumeRateLimit(key, 60_000, 1)).toBe(false)
    resetRateLimitForTests()
    expect(await consumeRateLimit(key, 60_000, 1)).toBe(true)
  })

  test('evicts a key once its own window has fully elapsed, even if nothing calls it again', async () => {
    await consumeRateLimit('test:evict-abandoned', 40, 1)
    expect(rateLimitTrackedKeyCountForTests()).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 70))
    // A call for an unrelated key still sweeps the whole map first.
    await consumeRateLimit('test:evict-trigger', 60_000, 1)

    expect(rateLimitTrackedKeyCountForTests()).toBe(1)
  })

  test('caps the number of tracked keys, dropping the oldest once the cap is reached', async () => {
    for (let index = 0; index < MAX_TRACKED_KEYS; index += 1) {
      await consumeRateLimit(`test:cap-${index}`, 60_000, 1)
    }
    expect(rateLimitTrackedKeyCountForTests()).toBe(MAX_TRACKED_KEYS)

    // One more distinct key must evict the oldest rather than grow past the cap.
    expect(await consumeRateLimit('test:cap-0', 60_000, 1)).toBe(false)
    expect(await consumeRateLimit('test:cap-overflow', 60_000, 1)).toBe(true)
    expect(rateLimitTrackedKeyCountForTests()).toBe(MAX_TRACKED_KEYS)
    // The oldest key ('test:cap-0') was dropped, so it is treated as fresh again.
    expect(await consumeRateLimit('test:cap-0', 60_000, 1)).toBe(true)
  }, CAP_CASE_TIMEOUT_MS)
})
