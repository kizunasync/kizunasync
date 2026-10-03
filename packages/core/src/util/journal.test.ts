/// <reference types="bun" />
/**
 * The journal session owns the read-on-mount, re-read-on-event protocol the
 * rejection and overwrite bindings are adapters over. Under test: which events
 * count, that a slow read never overwrites a newer one, that a failed read is
 * reported rather than swallowed, and that dismiss acknowledges before it
 * re-reads.
 */
// MARK: - createJournalSession

import { describe, expect, test } from 'bun:test'
import { createJournalSession, isOverwriteEvent, isRejectionEvent } from './journal'
import { EConflictMode, EEngineEventType, ERejectReason, type TEngineEvent } from '../wire/types'

interface IDeferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
}

const defer = <T>(): IDeferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })

  return { promise, resolve, reject }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const makeClient = (): { client: { on: (handler: (event: TEngineEvent) => void) => () => void }; emit: (event: TEngineEvent) => void; handlers: () => number } => {
  const handlers = new Set<(event: TEngineEvent) => void>()

  return {
    client: {
      on: (handler) => {
        handlers.add(handler)

        return () => handlers.delete(handler)
      },
    },
    emit: (event) => handlers.forEach((handler) => handler(event)),
    handlers: () => handlers.size,
  }
}

const REJECTED: TEngineEvent = { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm1', reason: ERejectReason.RLS_DENIED }
const ABORTED: TEngineEvent = { type: EEngineEventType.BATCH_ABORTED, offenderMutationId: 'm1', reason: ERejectReason.PRECONDITION }
const DEAD: TEngineEvent = { type: EEngineEventType.DEAD_LETTER, mutationId: 'm1', reason: 'PERMANENT_TRANSPORT' }
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

describe('journal event predicates', () => {
  test('a rejection journal row is added by exactly three event types', () => {
    expect([REJECTED, ABORTED, DEAD].map(isRejectionEvent)).toEqual([true, true, true])
    expect([OVERWRITTEN, LOCAL].map(isRejectionEvent)).toEqual([false, false])
  })

  test('an overwrite journal row is added by COLUMN_OVERWRITTEN alone', () => {
    expect(isOverwriteEvent(OVERWRITTEN)).toBe(true)
    expect([REJECTED, ABORTED, DEAD, LOCAL].map(isOverwriteEvent)).toEqual([false, false, false, false])
  })
})

describe('createJournalSession', () => {
  test('reads once when the subscription starts', async () => {
    const { client } = makeClient()
    const rows: string[][] = []
    const session = createJournalSession<string>({
      client,
      read: () => Promise.resolve(['a']),
      isRelevant: isRejectionEvent,
      onRows: (next) => rows.push([...next]),
      onError: () => undefined,
    })

    await flush()
    expect(rows).toEqual([['a']])
    session.dispose()
  })

  test('a relevant event re-reads and an irrelevant one does not', async () => {
    const { client, emit } = makeClient()
    let reads = 0
    const session = createJournalSession<string>({
      client,
      read: () => {
        reads += 1

        return Promise.resolve([])
      },
      isRelevant: isOverwriteEvent,
      onRows: () => undefined,
      onError: () => undefined,
    })

    await flush()
    expect(reads).toBe(1)

    emit(REJECTED)
    await flush()
    expect(reads).toBe(1)

    emit(OVERWRITTEN)
    await flush()
    expect(reads).toBe(2)
    session.dispose()
  })

  test('a slow read never overwrites a newer one', async () => {
    const { client, emit } = makeClient()
    const pending: IDeferred<readonly string[]>[] = []
    const rows: string[][] = []
    const session = createJournalSession<string>({
      client,
      read: () => {
        const next = defer<readonly string[]>()

        pending.push(next)

        return next.promise
      },
      isRelevant: isRejectionEvent,
      onRows: (next) => rows.push([...next]),
      onError: () => undefined,
    })

    emit(REJECTED)
    expect(pending.length).toBe(2)

    pending[1]?.resolve(['newest'])
    await flush()
    pending[0]?.resolve(['stale'])
    await flush()

    expect(rows).toEqual([['newest']])
    session.dispose()
  })

  test('a failed read is reported, not swallowed', async () => {
    const { client } = makeClient()
    const failures: string[] = []
    const session = createJournalSession<string>({
      client,
      read: () => Promise.reject(new Error('local store is closed')),
      isRelevant: isRejectionEvent,
      onRows: () => undefined,
      onError: (error) => failures.push(error.message),
    })

    await flush()
    expect(failures).toEqual(['local store is closed'])
    session.dispose()
  })

  test('a non-Error rejection is normalized before it is reported', async () => {
    const { client } = makeClient()
    const failures: Error[] = []
    const session = createJournalSession<string>({
      client,
      read: () => Promise.reject('closed'),
      isRelevant: isRejectionEvent,
      onRows: () => undefined,
      onError: (error) => failures.push(error),
    })

    await flush()
    expect(failures[0]).toBeInstanceOf(Error)
    expect(failures[0]?.message).toBe('closed')
    session.dispose()
  })

  test('dismiss acknowledges before it re-reads', async () => {
    const { client } = makeClient()
    const order: string[] = []
    const session = createJournalSession<string>({
      client,
      read: () => {
        order.push('read')

        return Promise.resolve([])
      },
      isRelevant: isRejectionEvent,
      onRows: () => undefined,
      onError: () => undefined,
    })

    await flush()
    order.length = 0

    await session.dismiss(() => {
      order.push('acknowledge')

      return Promise.resolve()
    })
    expect(order).toEqual(['acknowledge', 'read'])
    session.dispose()
  })

  test('a failed acknowledgement rejects and never re-reads', async () => {
    const { client } = makeClient()
    let reads = 0
    const session = createJournalSession<string>({
      client,
      read: () => {
        reads += 1

        return Promise.resolve([])
      },
      isRelevant: isRejectionEvent,
      onRows: () => undefined,
      onError: () => undefined,
    })

    await flush()
    expect(
      session.dismiss(() => Promise.reject(new Error('journal write failed'))),
    ).rejects.toThrow('journal write failed')
    await flush()
    expect(reads).toBe(1)
    session.dispose()
  })

  test('dispose unsubscribes and invalidates any in-flight read', async () => {
    const { client, emit, handlers } = makeClient()
    const pending: IDeferred<readonly string[]>[] = []
    const rows: string[][] = []
    const session = createJournalSession<string>({
      client,
      read: () => {
        const next = defer<readonly string[]>()

        pending.push(next)

        return next.promise
      },
      isRelevant: isRejectionEvent,
      onRows: (next) => rows.push([...next]),
      onError: () => undefined,
    })

    expect(handlers()).toBe(1)
    session.dispose()
    expect(handlers()).toBe(0)

    emit(REJECTED)
    pending[0]?.resolve(['stale'])
    await flush()
    expect(rows).toEqual([])
    expect(pending.length).toBe(1)
  })
})
