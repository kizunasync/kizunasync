/// <reference types="bun" />
// MARK: - The pack's push-policy rejections dead-letter the write

/**
 * `kizunasync.push` raises KZP01 for a mutation against a pull-only table and
 * KZP02 for a batch over `max_batch_size`. Those two are definitive rejections
 * of the request as sent. KZP03 (`require_atomic`) stays retryable: ordinary
 * writes are non-atomic.
 *
 * Driven end to end through the real engine: "permanent" is only meaningful as
 * the thing the push loop counts against that budget.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { byOwner, createKizunaSync, defineConfig, EEngineEventType, type IKizunaSync, type TEngineEvent } from '@kizunasync/core'
import { createTempDatabase } from '@kizunasync/core/testing'
import { createRpcRemote } from './rpc-remote'

/**
 * Consecutive permanent push failures against the same head before the engine
 * drops it (DEAD_LETTER_BUDGET in the engine's orchestration).
 */
const DEAD_LETTER_BUDGET = 5

/**
 * Engine events cross the addon boundary on the event loop, so they land a tick
 * after the call that produced them.
 */
const flushEvents = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

const EMPTY_PULL = { cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }

/**
 * The adapter arms a per-request deadline, so the fake answers the same
 * awaitable-and-chainable builder supabase-js returns from .rpc().
 */
const answering = (result: { data: unknown; error: unknown }) => {
  const settled = Promise.resolve(result)

  return { abortSignal: () => settled, then: settled.then.bind(settled) }
}

/**
 * A project whose `push` raises one PostgREST error and whose `pull` answers an
 * empty page, so `sync()` exercises the push half alone.
 */
const clientRejectingPush = (error: { message: string; code: string }): SupabaseClient =>
  ({
    schema: () => ({
      rpc: (fn: string) =>
        answering(fn === 'push' ? { data: null, error } : { data: EMPTY_PULL, error: null }),
    }),
  }) as unknown as SupabaseClient

const config = defineConfig({
  tables: { items: { sync: 'read-write', bucket: byOwner('user_id') } },
})

const open: Array<() => void> = []

const start = (error: { message: string; code: string }): IKizunaSync => {
  const temp = createTempDatabase('kizunasync-push-policy')
  const kizunasync = createKizunaSync(temp.driver, createRpcRemote(clientRejectingPush(error)), config, {
    pollIntervalMs: 0,
  })

  open.push(() => {
    kizunasync.dispose()
    temp.remove()
  })
  kizunasync.setBucket({ user_id: 'u1' })

  return kizunasync
}

/**
 * The addon is what `createKizunaSync` runs on Bun; without it there is no engine to
 * drive and the classification has nothing to act on.
 */
const hasEngine = ((): boolean => {
  try {
    const probe = start({ code: 'KZP01', message: 'probe' })

    probe.dispose()

    return true
  } catch {
    return false
  } finally {
    while (open.length > 0) {
      open.pop()?.()
    }
  }
})()

describe.skipIf(!hasEngine)('a push-policy rejection reaches the dead letter', () => {
  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.()
    }
  })

  const assertDeadLetters = async (code: string, message: string): Promise<void> => {
    const kizunasync = start({ code, message })
    const events: TEngineEvent[] = []

    kizunasync.on((event) => events.push(event))
    await kizunasync.from('items').insert({ title: 'doomed', user_id: 'u1' })

    for (let attempt = 1; attempt < DEAD_LETTER_BUDGET; attempt += 1) {
      await expect(kizunasync.sync()).rejects.toThrow(message)
    }
    expect(await kizunasync.getOutboxDepth()).toBe(1)

    await kizunasync.sync()
    await flushEvents()
    expect(await kizunasync.getOutboxDepth()).toBe(0)
    expect(events.some((event) => event.type === EEngineEventType.DEAD_LETTER)).toBe(true)
  }

  test('KZP01, a mutation against a pull-only table', async () => {
    await assertDeadLetters(
      'KZP01',
      'kizunasync.push(): table "items" is pull-only (sync_mode), pushes are rejected',
    )
  })

  test('KZP02, a batch over max_batch_size', async () => {
    await assertDeadLetters(
      'KZP02',
      'kizunasync.push(): batch of 51 mutations exceeds max_batch_size 50',
    )
  })

  test('KZP03, a non-atomic push under require_atomic, stays queued', async () => {
    const message = 'kizunasync.push(): require_atomic is set, non-atomic push rejected'
    const kizunasync = start({ code: 'KZP03', message })
    const events: TEngineEvent[] = []

    kizunasync.on((event) => events.push(event))
    await kizunasync.from('items').insert({ title: 'held', user_id: 'u1' })

    for (let attempt = 0; attempt < DEAD_LETTER_BUDGET + 1; attempt += 1) {
      await expect(kizunasync.sync()).rejects.toThrow(message)
    }
    expect(await kizunasync.getOutboxDepth()).toBe(1)
    expect(events.some((event) => event.type === EEngineEventType.DEAD_LETTER)).toBe(false)
  })
})
