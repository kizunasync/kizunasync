/// <reference types="bun" />
/**
 * What the adapter reads back from the engine outside a call's answer: the
 * events a backend hands the `onEvent` callback, and the checkpoint state.
 *
 * The addon invokes `onEvent` from a threadsafe function, so a throw that
 * leaves it reaches `napi_fatal_exception`. An event the adapter cannot read
 * or does not know is dropped with a debug log, and any other failure while
 * handling one, an app subscriber's or a health listener's included, is logged
 * through the client logger and stops there.
 *
 * A fake addon stands in for the native one: the adapter is under test, not
 * the Rust core, so the suite does not need `cargo build`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createRustEngine } from './rust-engine'
import type { IAppClientEngine } from './select-engine'
import type { INapiAddon, INapiEngine } from './napi-loader'
import type { ILogger } from '../util/logger'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { ISyncHealth } from '../host/sync-health'
import { EEngineErrorCode, EEngineEventType, ESoftBlockReason, TEngineError, type TEngineConfig, type TEngineEvent } from '../wire/types'

const CONFIG: TEngineConfig = {
  tables: { todos: { bucketColumn: 'owner_id', bucketParams: { owner_id: 'user-a' } } },
  schemaVersion: 1,
}

const NOW = '2024-01-01T00:00:00.000Z'

const idleRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('the fake addon never calls the remote')),
  push: () => Promise.reject(new Error('the fake addon never calls the remote')),
}

// MARK: - Harness

type TLogLine = { level: 'debug' | 'info' | 'warn' | 'error'; message: string; meta: unknown }

type TEventHarness = {
  engine: IAppClientEngine

  /** Hands one raw event to the callback the adapter opened the engine with, as the addon does. */
  emit: (eventJson: string) => void

  lines: TLogLine[]

  /** The engine methods the adapter called, in order. */
  methods: string[]
}

const recordingLogger = (lines: TLogLine[]): ILogger => {
  const at =
    (level: TLogLine['level']) =>
    (message: string, meta?: unknown): void => {
      lines.push({ level, message, meta })
    }
  const logger: ILogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }

  return logger
}

const opened: IAppClientEngine[] = []

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.dispose?.()
  }
})

const UNBLOCKED_CHECKPOINT = { cursor: '0', soft_blocked: false, soft_block_reason: null }

/** `checkpoint` is the value the fake answers a `checkpoint` call with. */
const harness = (checkpoint: unknown = UNBLOCKED_CHECKPOINT): TEventHarness => {
  const lines: TLogLine[] = []
  const methods: string[] = []
  let onEvent: (eventJson: string) => void = () => undefined
  const KizunaSyncEngine = function KizunaSyncEngine(
    this: INapiEngine,
    _configJson: string,
    _databasePath: string | null,
    _pull: (requestJson: string) => Promise<string>,
    _push: (requestJson: string) => Promise<string>,
    handler: (eventJson: string) => void,
  ): void {
    onEvent = handler
    this.call = (method: string) => {
      methods.push(method)

      return JSON.stringify({ ok: true, value: method === 'checkpoint' ? checkpoint : null })
    }
    this.close = () => undefined
  } as unknown as INapiAddon['KizunaSyncEngine']
  const engine = createRustEngine({
    addon: { ping: () => 'pong', KizunaSyncEngine },
    databasePath: null,
    remote: idleRemote,
    config: CONFIG,
    clientId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    uuid: () => '00000000-0000-4000-8000-000000000002',
    logger: recordingLogger(lines),
    deps: { pollIntervalMs: 0 },
  })

  opened.push(engine)

  return { engine, emit: (eventJson) => onEvent(eventJson), lines, methods }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Event payloads that are not a JSON object naming a `type`. */
const UNREADABLE_EVENTS = ['42', 'null', '{"kind":"LOCAL_CHANGED"}', 'not json']

const levelsAndMessages = (lines: TLogLine[]): Array<Pick<TLogLine, 'level' | 'message'>> =>
  lines.map(({ level, message }) => ({ level, message }))

// MARK: - Events

describe('the event callback never throws back into the addon', () => {
  test('an event type the adapter does not know is dropped with a debug log', () => {
    const run = harness()
    const seen: TEngineEvent[] = []

    run.engine.subscribe((event) => seen.push(event))

    expect(() => run.emit(JSON.stringify({ type: 'SOMETHING_NEW', depth: 1 }))).not.toThrow()
    expect(seen).toEqual([])
    expect(run.lines).toEqual([
      { level: 'debug', message: 'dropped an unknown engine event', meta: { type: 'SOMETHING_NEW' } },
    ])
  })

  test.each(UNREADABLE_EVENTS)('%s is dropped as an unreadable event with a debug log', (eventJson) => {
    const run = harness()
    const seen: TEngineEvent[] = []

    run.engine.subscribe((event) => seen.push(event))

    expect(() => run.emit(eventJson)).not.toThrow()
    expect(seen).toEqual([])
    expect(levelsAndMessages(run.lines)).toEqual([{ level: 'debug', message: 'dropped an unreadable engine event' }])
  })

  test('a throwing subscriber is logged and the next subscriber still receives the event', () => {
    const run = harness()
    const fault = new Error('the app subscriber broke')
    const seen: TEngineEvent[] = []

    run.engine.subscribe(() => {
      throw fault
    })
    run.engine.subscribe((event) => seen.push(event))

    expect(() => run.emit(JSON.stringify({ type: EEngineEventType.LOCAL_CHANGED }))).not.toThrow()
    expect(seen).toEqual([{ type: EEngineEventType.LOCAL_CHANGED }])
    expect(run.lines).toEqual([{ level: 'error', message: 'engine event subscriber failed', meta: fault }])
  })

  test('a throwing health listener is logged and the sync still settles', async () => {
    const run = harness()
    const fault = new Error('the app health listener broke')
    const listenerFailure: TLogLine = { level: 'error', message: 'sync health listener failed', meta: fault }

    run.engine.onSyncHealth(() => {
      throw fault
    })
    await run.engine.sync()

    expect(run.engine.getSyncHealth().lastSuccessAt).not.toBeNull()
    expect(run.lines.length).toBeGreaterThan(0)
    expect(run.lines).toEqual(run.lines.map(() => listenerFailure))
  })

  test('a failure while mapping a known event is logged and stops in the callback', () => {
    const run = harness()
    const seen: TEngineEvent[] = []

    run.engine.subscribe((event) => seen.push(event))
    const overwritten = {
      type: EEngineEventType.COLUMN_OVERWRITTEN,
      table: 'todos',
      pk: 'p1',
      column: 'title',
      loser_value: 'mine',
      winner_mutation_id: 'm2',
      conflict_mode: 'not-a-mode',
    }

    expect(() => run.emit(JSON.stringify(overwritten))).not.toThrow()
    expect(seen).toEqual([])
    expect(levelsAndMessages(run.lines)).toEqual([{ level: 'error', message: 'engine event handler failed' }])
    expect(run.lines[0]?.meta).toBeInstanceOf(TEngineError)
  })
})

// MARK: - Checkpoint

describe('the checkpoint state carries the soft-block reason', () => {
  test.each(['reset_required', 'identity_changed'])('a store soft-blocked for %s says so', async (reason) => {
    const run = harness({ cursor: '5', soft_blocked: true, soft_block_reason: reason })

    expect(await run.engine.getCheckpoint()).toEqual({
      cursor: '5',
      schemaVersion: 1,
      softBlocked: true,
      softBlockReason: reason,
    })
  })

  test.each([
    { name: 'a null reason', value: { cursor: '5', soft_blocked: false, soft_block_reason: null } },
    { name: 'no reason field', value: { cursor: '5', soft_blocked: false } },
  ])('$name leaves the reason out', async ({ value }) => {
    const checkpoint = await harness(value).engine.getCheckpoint()

    expect(checkpoint).toEqual({ cursor: '5', schemaVersion: 1, softBlocked: false })
    expect('softBlockReason' in checkpoint).toBe(false)
  })

  test('a reason outside the closed set is refused with ENGINE_UNAVAILABLE', async () => {
    const run = harness({ cursor: '5', soft_blocked: true, soft_block_reason: 'moon_phase' })
    const refused: unknown = await run.engine.getCheckpoint().catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(TEngineError)
    expect((refused as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
  })
})

// MARK: - Soft-block reason

/**
 * The engine names why it soft-blocked sync on the `RESET_REQUIRED` that latched
 * the block, and in the checkpoint a store opens with. Both reach sync health, so
 * a UI reading health alone can tell a schema reset from a change of signed-in
 * account, and `reset()` clears it with the block.
 */
describe('the soft-block reason reaches subscribers and sync health', () => {
  const REASONS = [ESoftBlockReason.resetRequired, ESoftBlockReason.identityChanged]

  test.each(REASONS)('RESET_REQUIRED hands %s to subscribers and to sync health', (reason) => {
    const run = harness()
    const seen: TEngineEvent[] = []

    run.engine.subscribe((event) => seen.push(event))
    run.emit(JSON.stringify({ type: EEngineEventType.RESET_REQUIRED, reason }))

    expect(seen).toEqual([{ type: EEngineEventType.RESET_REQUIRED, reason }])
    expect(run.engine.getSyncHealth().softBlockReason).toBe(reason)
  })

  test('a RESET_REQUIRED that names no reason carries none and records none', () => {
    const run = harness()
    const seen: TEngineEvent[] = []

    run.engine.subscribe((event) => seen.push(event))
    run.emit(JSON.stringify({ type: EEngineEventType.RESET_REQUIRED }))

    expect(seen).toEqual([{ type: EEngineEventType.RESET_REQUIRED }])
    expect('reason' in seen[0]!).toBe(false)
    expect(run.engine.getSyncHealth().softBlockReason).toBeNull()
  })

  test('a reason outside the closed set is logged and the event stops in the callback', () => {
    const run = harness()
    const seen: TEngineEvent[] = []

    run.engine.subscribe((event) => seen.push(event))

    expect(() => run.emit(JSON.stringify({ type: EEngineEventType.RESET_REQUIRED, reason: 'moon_phase' }))).not.toThrow()
    expect(seen).toEqual([])
    expect(levelsAndMessages(run.lines)).toEqual([{ level: 'error', message: 'engine event handler failed' }])
    expect(run.engine.getSyncHealth().softBlockReason).toBeNull()
  })

  test.each(REASONS)('a store that opens soft-blocked for %s seeds sync health and tells its listeners', async (reason) => {
    const run = harness({ cursor: '5', soft_blocked: true, soft_block_reason: reason })
    const published: Array<ISyncHealth['softBlockReason']> = []

    run.engine.onSyncHealth((health) => published.push(health.softBlockReason))
    await flush()

    expect(run.engine.getSyncHealth().softBlockReason).toBe(reason)
    expect(published).toEqual([reason])
  })

  test('the store is read once at open, and an unblocked one seeds nothing', async () => {
    const run = harness()
    const published: ISyncHealth[] = []

    run.engine.onSyncHealth((health) => published.push(health))
    await flush()

    expect(run.methods).toEqual(['checkpoint'])
    expect(run.engine.getSyncHealth().softBlockReason).toBeNull()
    expect(published).toEqual([])
  })

  test('a checkpoint read at open that names an unknown reason is logged and seeds nothing', async () => {
    const run = harness({ cursor: '5', soft_blocked: true, soft_block_reason: 'moon_phase' })

    await flush()

    expect(levelsAndMessages(run.lines)).toEqual([{ level: 'error', message: 'soft block read failed' }])
    expect(run.engine.getSyncHealth().softBlockReason).toBeNull()
  })

  test('reset() clears the reason with the block', async () => {
    const run = harness({ cursor: '5', soft_blocked: true, soft_block_reason: ESoftBlockReason.identityChanged })

    await flush()
    expect(run.engine.getSyncHealth().softBlockReason).toBe(ESoftBlockReason.identityChanged)

    await run.engine.reset()

    expect(run.engine.getSyncHealth().softBlockReason).toBeNull()
  })
})
