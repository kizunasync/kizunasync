/// <reference types="bun" />
/**
 * The sync-status session owns the snapshot + verdict + health protocol the
 * React hook and the Vue composable are adapters over. Under test: which
 * verdicts reach `lastError`, that the automatic loop's own failures do not,
 * and the syncNow ordering that keeps a verdict emitted DURING a sync instead
 * of wiping it.
 */
// MARK: - createSyncStatusSession

import { describe, expect, test } from 'bun:test'
import { createSyncStatusSession, type ISyncStatusSessionOptions, type ISyncStatusState } from './sync-status'
import { ESyncPhase, type ISyncHealth } from '../host/sync-health'
import { EConflictMode, EEngineEventType, ERejectReason, INITIAL_CHECKPOINT_STATE, type TCheckpointState, type TEngineEvent } from '../wire/types'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const IDLE: ISyncHealth = {
  phase: ESyncPhase.idle,
  consecutiveFailures: 0,
  nextAttemptAt: 15_000,
  attemptStartedAt: null,
  lastSuccessAt: 1_000,
  lastError: null,
}

const CHECKPOINT: TCheckpointState = { ...INITIAL_CHECKPOINT_STATE, softBlocked: true }

interface IFakeClient {
  client: ISyncStatusSessionOptions['client']
  emit: (event: TEngineEvent) => void
  publish: (health: ISyncHealth) => void
  eventHandlers: () => number
  healthListeners: () => number
  syncCalls: () => number
  refreshCalls: () => number
}

const makeClient = (sync: () => Promise<void> = () => Promise.resolve()): IFakeClient => {
  const eventHandlers = new Set<(event: TEngineEvent) => void>()
  const healthListeners = new Set<(health: ISyncHealth) => void>()
  let syncCalls = 0
  let refreshCalls = 0

  return {
    client: {
      on: (handler) => {
        eventHandlers.add(handler)

        return () => eventHandlers.delete(handler)
      },
      sync: () => {
        syncCalls += 1

        return sync()
      },
      getSyncHealth: () => IDLE,
      onSyncHealth: (listener) => {
        healthListeners.add(listener)

        return () => healthListeners.delete(listener)
      },
      getOutboxDepth: () => {
        refreshCalls += 1

        return Promise.resolve(3)
      },
      getCheckpoint: () => Promise.resolve(CHECKPOINT),
    },
    emit: (event) => eventHandlers.forEach((handler) => handler(event)),
    publish: (health) => healthListeners.forEach((listener) => listener(health)),
    eventHandlers: () => eventHandlers.size,
    healthListeners: () => healthListeners.size,
    syncCalls: () => syncCalls,
    refreshCalls: () => refreshCalls,
  }
}

const record = (): { seen: ISyncStatusState[]; onChange: (state: ISyncStatusState) => void } => {
  const seen: ISyncStatusState[] = []

  return { seen, onChange: (state) => seen.push(state) }
}

const REJECTED: TEngineEvent = { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm1', reason: ERejectReason.RLS_DENIED }
const ABORTED: TEngineEvent = { type: EEngineEventType.BATCH_ABORTED, offenderMutationId: 'm1', reason: ERejectReason.PRECONDITION }
const DEAD: TEngineEvent = { type: EEngineEventType.DEAD_LETTER, mutationId: 'm1', reason: 'PERMANENT_TRANSPORT' }
const EXPIRED: TEngineEvent = { type: EEngineEventType.CHECKPOINT_EXPIRED }
const BLOCKED: TEngineEvent = { type: EEngineEventType.RESET_REQUIRED }
const OVERWRITTEN: TEngineEvent = {
  type: EEngineEventType.COLUMN_OVERWRITTEN,
  table: 'todos',
  pk: 'p1',
  column: 'title',
  loserValue: 'works on a plane',
  winnerMutationId: 'm2',
  conflictMode: EConflictMode.hlc,
}
const LOCAL: TEngineEvent = { type: EEngineEventType.LOCAL_CHANGED }
const QUEUE: TEngineEvent = { type: EEngineEventType.QUEUE_DEPTH, depth: 1 }

describe('createSyncStatusSession verdicts', () => {
  test('every error-level verdict becomes lastError', async () => {
    const titles: (string | undefined)[] = []

    for (const event of [REJECTED, ABORTED, DEAD, EXPIRED, BLOCKED]) {
      const fake = makeClient()
      const { seen, onChange } = record()
      const session = createSyncStatusSession({ client: fake.client, onChange })

      fake.emit(event)
      await flush()
      titles.push(seen.at(-1)?.lastError?.message.split(':')[0])
      session.dispose()
    }
    expect(titles).toEqual(['Write rejected', 'Batch aborted', 'Sync gave up', 'Checkpoint expired', 'Reset required'])
  })

  test('a warning-level verdict and a non-verdict leave lastError alone', async () => {
    const fake = makeClient()
    const { seen, onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    fake.emit(OVERWRITTEN)
    fake.emit(LOCAL)
    await flush()
    expect(seen.every((state) => state.lastError === null)).toBe(true)
    session.dispose()
  })

  test("the automatic loop's own failure stays in health and out of lastError", async () => {
    const fake = makeClient()
    const { seen, onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    fake.publish({
      ...IDLE,
      phase: ESyncPhase.backoff,
      consecutiveFailures: 2,
      lastError: { code: 'AUTH_SESSION_TIMEOUT', message: 'the session timed out', at: 20_000 },
    })
    expect(seen.at(-1)?.health.lastError?.code).toBe('AUTH_SESSION_TIMEOUT')
    expect(seen.at(-1)?.lastError).toBeNull()
    session.dispose()
  })
})

describe('createSyncStatusSession refresh gating', () => {
  test('a queue or sync event re-reads the outbox depth and checkpoint', async () => {
    const fake = makeClient()
    const { onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    await flush()
    const beforeRefreshCalls = fake.refreshCalls()

    for (const event of [QUEUE, LOCAL, REJECTED, ABORTED, DEAD, EXPIRED, BLOCKED]) {
      fake.emit(event)
      await flush()
    }
    expect(fake.refreshCalls()).toBe(beforeRefreshCalls + 7)
    session.dispose()
  })

  test('COLUMN_OVERWRITTEN alone re-reads nothing', async () => {
    const fake = makeClient()
    const { onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    await flush()
    const beforeRefreshCalls = fake.refreshCalls()

    fake.emit(OVERWRITTEN)
    await flush()
    expect(fake.refreshCalls()).toBe(beforeRefreshCalls)
    session.dispose()
  })
})

describe('createSyncStatusSession snapshot', () => {
  test('getState seeds a reader with the defaults plus the reported health', () => {
    const fake = makeClient()
    const { seen, onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    expect(session.getState()).toEqual({
      outboxDepth: 0,
      checkpoint: INITIAL_CHECKPOINT_STATE,
      isSyncing: false,
      lastError: null,
      health: IDLE,
    })
    expect(seen).toEqual([])
    session.dispose()
  })

  test('getState follows every change the reader was notified of', async () => {
    const fake = makeClient()
    const { seen, onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    await flush()
    expect(session.getState()).toEqual(seen.at(-1) as ISyncStatusState)
    expect(session.getState().outboxDepth).toBe(3)
    session.dispose()
  })

  test('the first read commits the outbox depth and the checkpoint', async () => {
    const fake = makeClient()
    const { seen, onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    await flush()
    expect(seen.at(-1)?.outboxDepth).toBe(3)
    expect(seen.at(-1)?.checkpoint.softBlocked).toBe(true)
    session.dispose()
  })

  test('a failed read is reported in lastError', async () => {
    const fake = makeClient()
    const client: ISyncStatusSessionOptions['client'] = {
      ...fake.client,
      getOutboxDepth: () => Promise.reject(new Error('local store is closed')),
    }
    const { seen, onChange } = record()
    const session = createSyncStatusSession({ client, onChange })

    await flush()
    expect(seen.at(-1)?.lastError?.message).toBe('local store is closed')
    session.dispose()
  })
})

describe('createSyncStatusSession syncNow', () => {
  test('lastError is cleared and isSyncing raised before sync() is called', async () => {
    let atCall: ISyncStatusState | undefined
    const { seen, onChange } = record()
    const fake = makeClient(() => {
      atCall = seen.at(-1)

      return Promise.resolve()
    })
    const session = createSyncStatusSession({ client: fake.client, onChange })

    fake.emit(REJECTED)
    await flush()
    expect(seen.at(-1)?.lastError).not.toBeNull()

    await session.syncNow()
    expect(atCall?.lastError).toBeNull()
    expect(atCall?.isSyncing).toBe(true)
    expect(seen.at(-1)?.isSyncing).toBe(false)
    session.dispose()
  })

  test('a rejected sync lands in lastError and settles the promise', async () => {
    const fake = makeClient(() => Promise.reject(new Error('transport is down')))
    const { seen, onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    await session.syncNow()
    expect(fake.syncCalls()).toBe(1)
    expect(seen.at(-1)?.lastError?.message).toBe('transport is down')
    expect(seen.at(-1)?.isSyncing).toBe(false)
    session.dispose()
  })

  test('a verdict emitted during the sync survives it', async () => {
    const fake = makeClient(async () => {
      fake.emit(DEAD)
    })
    const { seen, onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    await session.syncNow()
    await flush()
    expect(seen.at(-1)?.lastError?.message).toContain('Sync gave up')
    session.dispose()
  })
})

describe('createSyncStatusSession lifecycle', () => {
  test('dispose drops both subscriptions', () => {
    const fake = makeClient()
    const { onChange } = record()
    const session = createSyncStatusSession({ client: fake.client, onChange })

    expect(fake.eventHandlers()).toBe(1)
    expect(fake.healthListeners()).toBe(1)

    session.dispose()
    expect(fake.eventHandlers()).toBe(0)
    expect(fake.healthListeners()).toBe(0)
  })
})
