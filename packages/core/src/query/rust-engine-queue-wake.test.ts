/// <reference types="bun" />
// MARK: - Local-write wake

/**
 * A local write has to leave the outbox on its own. The engine's event bus is
 * what tells the scheduler one landed: `QUEUE_DEPTH` with a non-zero depth is
 * emitted only after a local apply, so the wake fires exactly when there is
 * something to push and never after a pull, which emits `LOCAL_CHANGED`. An
 * attachment retry puts a transfer back in the queue without a local write, so
 * it wakes the loop itself.
 *
 * A fake addon stands in for the native one: the wiring is under test, not the
 * Rust core, so the suite does not need `cargo build`. The timer pair and the
 * connectivity port are injected, so every assertion below is exact. Each
 * scenario starts once the loop's own start attempt has run.
 */

import { describe, expect, test } from 'bun:test'
import { createRustEngine } from './rust-engine'
import { WAKE_DEBOUNCE_MS } from '../host/sync-scheduler'
import { noopLogger } from '../util/logger'
import type { INapiAddon, INapiEngine } from './napi-loader'
import type { IAppClientEngine } from './select-engine'
import type { IConnectivity } from '../ports/connectivity'
import type { IFileStore } from '../ports/file-store'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { ITransfer } from '../ports/transfer'
import { EEngineEventType, ERejectReason, type TEngineConfig, type TEngineDeps } from '../wire/types'

const CONFIG: TEngineConfig = {
  tables: { todos: { bucketColumn: 'owner_id', bucketParams: { owner_id: 'user-a' } } },
  schemaVersion: 1,
}

const NOW = '2024-01-01T00:00:00.000Z'

const idleRemote: IProtocolRemote = {
  pull: async () => ({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: async () => ({ verdicts: [] }),
}

/** Sentinels: a retry reaches only the engine's queue row, never the bytes. */
const ATTACHMENT_PORTS: Pick<TEngineDeps, 'fileStore' | 'transfer'> = {
  fileStore: {} as unknown as IFileStore,
  transfer: {} as unknown as ITransfer,
}

// MARK: - Harness

type TQueueWakeHarness = {
  engine: IAppClientEngine

  /** Fire one engine event at the bus, as Rust's `onEvent` would. */
  emit: (event: Record<string, unknown>) => void

  /** Engine methods the scheduler's attempts reached, in order. */
  calls: string[]

  /** Run every timer due now, letting the callbacks re-arm as they go. */
  fire: () => Promise<void>

  armedDelays: number[]
  setOnline: (value: boolean) => void
  dispose: () => void
}

/**
 * A rust engine over a fake addon, a fake connectivity, and a manual timer.
 * `callOutcome` decides what an engine call does, so an attempt can be made to
 * reject without touching the remote.
 */
const openHarness = (callOutcome: (method: string) => 'ok' | 'fail', ports: Pick<TEngineDeps, 'fileStore' | 'transfer'>): TQueueWakeHarness => {
  const calls: string[] = []
  const armedDelays: number[] = []
  const pending = new Map<number, () => void>()
  let nextHandle = 0
  let online = true
  let emitEvent: (eventJson: string) => void = () => undefined

  const KizunaSyncEngine = function KizunaSyncEngine(
    this: INapiEngine,
    _configJson: string,
    _databasePath: string | null,
    _pull: (requestJson: string) => Promise<string>,
    _push: (requestJson: string) => Promise<string>,
    onEvent: (eventJson: string) => void,
  ): void {
    emitEvent = onEvent
    this.call = (method: string) => {
      // The checkpoint read the adapter makes as it opens is not an attempt of the loop under test.
      if (method === 'checkpoint') {
        return JSON.stringify({ ok: true, value: { cursor: '0', soft_blocked: false } })
      }
      calls.push(method)

      if (callOutcome(method) === 'fail') {
        return JSON.stringify({ ok: false, error: { kind: 'remote', message: 'remote unreachable' } })
      }
      return JSON.stringify({ ok: true, value: null })
    }
    this.close = () => undefined
  } as unknown as INapiAddon['KizunaSyncEngine']

  const connectivity: IConnectivity = {
    isOnline: () => online,
    subscribe: () => () => undefined,
  }

  const engine = createRustEngine({
    addon: { ping: () => 'pong', KizunaSyncEngine },
    databasePath: null,
    remote: idleRemote,
    config: CONFIG,
    clientId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    uuid: () => '00000000-0000-4000-8000-000000000002',
    logger: noopLogger,
    deps: {
      ...ports,
      connectivity,
      pollIntervalMs: 0,
      setTimer: (callback, delayMs) => {
        armedDelays.push(delayMs)
        nextHandle += 1
        pending.set(nextHandle, callback)

        return nextHandle
      },
      clearTimer: (handle) => {
        pending.delete(handle as number)
      },
    },
  })

  return {
    engine,
    emit: (event) => {
      emitEvent(JSON.stringify(event))
    },
    calls,
    fire: async () => {
      const due = [...pending.values()]

      pending.clear()

      for (const callback of due) {
        callback()
      }
      // A network call waits for the local calls issued before it, the open-time checkpoint read included, so the attempt reaches the engine a task later.
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    armedDelays,
    setOnline: (value) => {
      online = value
    },
    dispose: () => {
      engine.dispose?.()
    },
  }
}

/** The harness after the loop's start attempt, with its call and timer records cleared. */
const harness = async (callOutcome: (method: string) => 'ok' | 'fail' = () => 'ok', ports: Pick<TEngineDeps, 'fileStore' | 'transfer'> = {}): Promise<TQueueWakeHarness> => {
  const run = openHarness(callOutcome, ports)

  await run.fire()
  run.calls.length = 0
  run.armedDelays.length = 0

  return run
}

// MARK: - Tests

describe('rust engine: a local write wakes the sync loop', () => {
  test('a non-empty queue depth arms one attempt at the wake debounce', async () => {
    const run = await harness()

    run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 3 })
    expect(run.armedDelays).toEqual([WAKE_DEBOUNCE_MS])
    expect(run.calls).toEqual([])

    await run.fire()
    expect(run.calls).toEqual(['sync'])
    run.dispose()
  })

  test('an empty queue depth, a pull, and a rejection arm nothing', async () => {
    const run = await harness()

    run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 0 })
    run.emit({ type: EEngineEventType.LOCAL_CHANGED })
    run.emit({
      type: EEngineEventType.MUTATION_REJECTED,
      mutation_id: 'm1',
      reason: ERejectReason.RLS_DENIED,
    })

    expect(run.armedDelays).toEqual([])
    await run.fire()
    expect(run.calls).toEqual([])
    run.dispose()
  })

  test('a burst of local writes inside the debounce window leads to one attempt', async () => {
    const run = await harness()

    for (let write = 1; write <= 5; write += 1) {
      run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: write })
    }
    expect(run.armedDelays).toEqual([WAKE_DEBOUNCE_MS])

    await run.fire()
    expect(run.calls).toEqual(['sync'])
    run.dispose()
  })

  test('an offline write reaches no engine sync', async () => {
    const run = await harness()

    run.setOnline(false)
    run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 })

    await run.fire()
    expect(run.calls).toEqual([])
    run.dispose()
  })

  test('a rejected attempt starts no second attempt from the same write', async () => {
    const run = await harness(() => 'fail')

    run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 })
    await run.fire()
    expect(run.calls).toEqual(['sync'])

    // The poll is off, so nothing else is owed: the backoff owns the retry.
    await run.fire()
    expect(run.calls).toEqual(['sync'])
    run.dispose()
  })

  test('dispose drops the subscription, so a late event arms nothing', async () => {
    const run = await harness()

    run.dispose()
    run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 2 })

    expect(run.armedDelays).toEqual([])
    await run.fire()
    expect(run.calls).toEqual([])
  })
})

describe('rust engine: an attachment retry wakes the sync loop', () => {
  test('a retry arms one attempt at the wake debounce, the way a local write does', async () => {
    const run = await harness(() => 'ok', ATTACHMENT_PORTS)

    await run.engine.attachments!.retry('u1/p1/a.png')
    expect(run.calls).toEqual(['attachment_retry'])
    expect(run.armedDelays).toEqual([WAKE_DEBOUNCE_MS])

    await run.fire()
    expect(run.calls).toEqual(['attachment_retry', 'sync_push', 'outbox_depth', 'sync_pull'])
    run.dispose()
  })

  test('a burst of retries inside the debounce window leads to one attempt', async () => {
    const run = await harness(() => 'ok', ATTACHMENT_PORTS)

    await run.engine.attachments!.retry('u1/p1/a.png')
    await run.engine.attachments!.retry('u1/p1/b.png')
    expect(run.armedDelays).toEqual([WAKE_DEBOUNCE_MS])

    await run.fire()
    expect(run.calls.filter((method) => method === 'sync_push')).toEqual(['sync_push'])
    run.dispose()
  })

  test('a retry the engine refuses arms nothing', async () => {
    const run = await harness((method) => (method === 'attachment_retry' ? 'fail' : 'ok'), ATTACHMENT_PORTS)

    await expect(run.engine.attachments!.retry('u1/p1/a.png')).rejects.toThrow('remote unreachable')
    expect(run.armedDelays).toEqual([])
    run.dispose()
  })
})
