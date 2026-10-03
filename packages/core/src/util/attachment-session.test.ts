/// <reference types="bun" />
/**
 * The attachment session owns the per-ref watch protocol the React hook and the
 * Vue composable are adapters over. Under test: the subscription swap, the
 * once-per-ref auto-fetch, and the guards that stop a continuation started for
 * one reference from committing onto the next one.
 */
// MARK: - createAttachmentSession

import { describe, expect, test } from 'bun:test'
import { createAttachmentSession } from './attachment-session'
import type { IAttachmentClient, TAttachmentStatus } from '../host/attachment-queue'
import { EAttachmentState } from '../wire/types'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface IFakeQueue {
  attachments: IAttachmentClient
  watched: string[]
  unwatched: string[]
  downloads: string[]
  emit: (ref: string, status: TAttachmentStatus) => void
}

/**
 * `uris` seeds the local URI each reference reports; a `null` entry is a
 * reference whose bytes are not on this device, so the lazy download arms.
 * `downloadGates` and `retryGates` hold an operation open until the test
 * resolves it.
 */
const makeQueue = (
  uris: Map<string, string | null>,
  downloadGates: Map<string, Promise<void>> = new Map(),
  retryGates: Map<string, Promise<void>> = new Map(),
): IFakeQueue => {
  const watched: string[] = []
  const unwatched: string[] = []
  const downloads: string[] = []
  const listeners = new Map<string, (status: TAttachmentStatus) => void>()

  const statusOf = (ref: string): TAttachmentStatus => ({
    state: EAttachmentState.synced,
    progress: 100,
    localUri: uris.get(ref) ?? null,
    error: null,
    permanent: false,
    attempts: 0,
  })

  const attachments: IAttachmentClient = {
    fromFile: () => Promise.reject(new Error('fromFile is not exercised here')),
    vacuum: () => Promise.resolve(),
    retry: async (ref) => {
      await retryGates.get(ref)
    },
    cancel: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    resolveDownload: async (ref) => {
      downloads.push(ref)
      await downloadGates.get(ref)
      const landed = `uri-${ref}`

      uris.set(ref, landed)

      return landed
    },
    getStatus: (ref) => Promise.resolve(statusOf(ref)),
    watch: (ref, callback) => {
      watched.push(ref)
      listeners.set(ref, callback)

      return () => {
        unwatched.push(ref)
        listeners.delete(ref)
      }
    },
  }

  return {
    attachments,
    watched,
    unwatched,
    downloads,
    emit: (ref, status) => listeners.get(ref)?.(status),
  }
}

const localUris = (entries: Record<string, string | null>): Map<string, string | null> =>
  new Map(Object.entries(entries))

const record = (): { seen: (TAttachmentStatus | null)[]; onStatus: (status: TAttachmentStatus | null) => void } => {
  const seen: (TAttachmentStatus | null)[] = []

  return { seen, onStatus: (status) => seen.push(status) }
}

describe('createAttachmentSession', () => {
  test('a null reference stays idle and subscribes to nothing', async () => {
    const queue = makeQueue(localUris({}))
    const { seen, onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef(null)
    await flush()
    expect(seen).toEqual([null])
    expect(queue.watched).toEqual([])
    session.dispose()
  })

  test('setting a reference clears the previous status, reads once, and watches', async () => {
    const queue = makeQueue(localUris({ a: 'uri-a' }))
    const { seen, onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef('a')
    await flush()
    expect(queue.watched).toEqual(['a'])
    expect(seen[0]).toBeNull()
    expect(seen.at(-1)?.localUri).toBe('uri-a')
    session.dispose()
  })

  test('changing the reference drops the previous watch and follows the new one', async () => {
    const queue = makeQueue(localUris({ a: 'uri-a', b: 'uri-b' }))
    const { seen, onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef('a')
    await flush()
    session.setRef('b')
    await flush()
    expect(queue.unwatched).toEqual(['a'])
    expect(queue.watched).toEqual(['a', 'b'])
    expect(seen.at(-1)?.localUri).toBe('uri-b')
    session.dispose()
  })

  test('a reference with no local uri auto-fetches its bytes exactly once', async () => {
    const queue = makeQueue(localUris({ a: null }))
    const { seen, onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef('a')
    await flush()
    expect(queue.downloads).toEqual(['a'])
    expect(seen.at(-1)?.localUri).toBe('uri-a')

    session.refresh()
    await flush()
    expect(queue.downloads).toEqual(['a'])
    session.dispose()
  })

  test('a watch update reaches the reader', async () => {
    const queue = makeQueue(localUris({ a: 'uri-a' }))
    const { seen, onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef('a')
    await flush()
    queue.emit('a', {
      state: EAttachmentState.downloading,
      progress: 42,
      localUri: 'uri-a',
      error: null,
      permanent: false,
      attempts: 0,
    })
    expect(seen.at(-1)?.progress).toBe(42)
    expect(seen.at(-1)?.state).toBe(EAttachmentState.downloading)
    session.dispose()
  })

  test('a download started for the previous reference does not commit onto the current one', async () => {
    let openGateA!: () => void
    const gateA = new Promise<void>((resolve) => {
      openGateA = resolve
    })
    const queue = makeQueue(localUris({ a: null, b: 'uri-b' }), new Map([['a', gateA]]))
    const { seen, onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef('a')
    await flush()
    expect(queue.downloads).toEqual(['a'])

    session.setRef('b')
    await flush()
    expect(seen.at(-1)?.localUri).toBe('uri-b')

    openGateA()
    await flush()
    expect(seen.at(-1)?.localUri).toBe('uri-b')
    session.dispose()
  })

  test('a retry that settles after the reference changed neither re-fetches it nor touches the new one', async () => {
    let openRetryA!: () => void
    const retryA = new Promise<void>((resolve) => {
      openRetryA = resolve
    })
    const queue = makeQueue(localUris({ a: 'uri-a', b: 'uri-b' }), new Map(), new Map([['a', retryA]]))
    const { seen, onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef('a')
    await flush()
    session.retry()

    session.setRef('b')
    await flush()
    expect(seen.at(-1)?.localUri).toBe('uri-b')
    const committed = seen.length

    openRetryA()
    await flush()
    expect(queue.downloads).toEqual([])
    expect(seen.length).toBe(committed)
    expect(seen.at(-1)?.localUri).toBe('uri-b')
    session.dispose()
  })

  test('retry forgives the budget and re-arms the auto-fetch for the same reference', async () => {
    const uris = localUris({ a: null })
    const queue = makeQueue(uris)
    const { onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef('a')
    await flush()
    expect(queue.downloads).toEqual(['a'])

    uris.set('a', null)
    session.retry()
    await flush()
    expect(queue.downloads).toEqual(['a', 'a'])
    session.dispose()
  })

  test('cancel and remove re-read the reference they were called for', async () => {
    const queue = makeQueue(localUris({ a: 'uri-a' }))
    const { seen, onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef('a')
    await flush()
    const afterSetRef = seen.length

    session.cancel()
    await flush()
    session.remove()
    await flush()
    expect(seen.length).toBe(afterSetRef + 2)
    session.dispose()
  })

  test('dispose unwatches and invalidates every in-flight continuation', async () => {
    let openGateA!: () => void
    const gateA = new Promise<void>((resolve) => {
      openGateA = resolve
    })
    const queue = makeQueue(localUris({ a: null }), new Map([['a', gateA]]))
    const { seen, onStatus } = record()
    const session = createAttachmentSession({ attachments: queue.attachments, onStatus })

    session.setRef('a')
    await flush()
    const beforeDispose = seen.length

    session.dispose()
    expect(queue.unwatched).toEqual(['a'])

    openGateA()
    await flush()
    expect(seen.length).toBe(beforeDispose)
  })
})
