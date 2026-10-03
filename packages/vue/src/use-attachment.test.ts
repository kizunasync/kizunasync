/// <reference types="bun" />
/**
 * Mirrors index.test.ts's effectScope pattern with a fake attachment queue that
 * records every watch, unwatch, and download it is asked for. The subject is the
 * reactive argument: a ref or getter that changes must swap the per-ref
 * subscription, and a download started for the previous ref must not land on the
 * current one (the guard React's use-attachment-stale test covers).
 */
// MARK: - useAttachment follows a MaybeRefOrGetter argument

import { describe, expect, test } from 'bun:test'
import { effectScope, ref } from 'vue'
import { EAttachmentState, type IAttachmentClient, type IKizunaSync, type TAttachmentStatus } from '@kizunasync/core'
import { useAttachment } from './use-attachment'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface IFakeQueue {
  client: IKizunaSync
  watched: string[]
  unwatched: string[]
  downloads: string[]
  emit: (attachmentRef: string, status: TAttachmentStatus) => void
}

/**
 * `uris` seeds the local URI each ref reports; a `null` entry is a ref whose
 * bytes are not on this device, so the lazy download arms. `gates` holds a
 * download open until the test resolves it, `retryGates` does the same for a
 * budget forgiveness.
 */
const makeFakeKizunaSync = (
  uris: Map<string, string | null>,
  gates: Map<string, Promise<void>> = new Map(),
  retryGates: Map<string, Promise<void>> = new Map(),
): IFakeQueue => {
  const watched: string[] = []
  const unwatched: string[] = []
  const downloads: string[] = []
  const listeners = new Map<string, (status: TAttachmentStatus) => void>()

  const statusOf = (attachmentRef: string): TAttachmentStatus => ({
    state: EAttachmentState.synced,
    progress: 100,
    localUri: uris.get(attachmentRef) ?? null,
    error: null,
    permanent: false,
    attempts: 0,
  })

  const attachments: IAttachmentClient = {
    fromFile: () => Promise.reject(new Error('fromFile is not exercised here')),
    vacuum: () => Promise.resolve(),
    retry: async (attachmentRef) => {
      await retryGates.get(attachmentRef)
    },
    cancel: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    resolveDownload: async (attachmentRef) => {
      downloads.push(attachmentRef)
      await gates.get(attachmentRef)
      const landed = `uri-${attachmentRef}`

      uris.set(attachmentRef, landed)

      return landed
    },
    getStatus: (attachmentRef) => Promise.resolve(statusOf(attachmentRef)),
    watch: (attachmentRef, callback) => {
      watched.push(attachmentRef)
      listeners.set(attachmentRef, callback)

      return () => {
        unwatched.push(attachmentRef)
        listeners.delete(attachmentRef)
      }
    },
  }

  return {
    client: { attachments } as unknown as IKizunaSync,
    watched,
    unwatched,
    downloads,
    emit: (attachmentRef, status) => listeners.get(attachmentRef)?.(status),
  }
}

const localUris = (entries: Record<string, string | null>): Map<string, string | null> =>
  new Map(Object.entries(entries))

describe('useAttachment reactive ref', () => {
  test('resubscribes and reports the new status when a ref changes', async () => {
    const fake = makeFakeKizunaSync(localUris({ a: 'uri-a', b: 'uri-b' }))
    const current = ref<string | null>('a')
    const scope = effectScope()
    let attachment!: ReturnType<typeof useAttachment>

    scope.run(() => {
      attachment = useAttachment(current, { client: fake.client })
    })

    await flush()
    expect(fake.watched).toEqual(['a'])
    expect(attachment.localUri.value).toBe('uri-a')

    current.value = 'b'
    await flush()
    expect(fake.unwatched).toEqual(['a'])
    expect(fake.watched).toEqual(['a', 'b'])
    expect(attachment.localUri.value).toBe('uri-b')
    scope.stop()
  })

  test('a getter argument is followed the same way a ref is', async () => {
    const fake = makeFakeKizunaSync(localUris({ a: 'uri-a', b: 'uri-b' }))
    const current = ref('a')
    const scope = effectScope()
    let attachment!: ReturnType<typeof useAttachment>

    scope.run(() => {
      attachment = useAttachment(() => current.value, { client: fake.client })
    })

    await flush()
    current.value = 'b'
    await flush()
    expect(fake.watched).toEqual(['a', 'b'])
    expect(attachment.localUri.value).toBe('uri-b')
    scope.stop()
  })

  test('a plain string subscribes once and never resubscribes', async () => {
    const fake = makeFakeKizunaSync(localUris({ a: 'uri-a' }))
    const scope = effectScope()
    let attachment!: ReturnType<typeof useAttachment>

    scope.run(() => {
      attachment = useAttachment('a', { client: fake.client })
    })

    await flush()
    expect(fake.watched).toEqual(['a'])
    expect(attachment.localUri.value).toBe('uri-a')
    scope.stop()
    expect(fake.unwatched).toEqual(['a'])
  })

  test('clearing the ref drops the subscription and returns to idle', async () => {
    const fake = makeFakeKizunaSync(localUris({ a: 'uri-a' }))
    const current = ref<string | null | undefined>('a')
    const scope = effectScope()
    let attachment!: ReturnType<typeof useAttachment>

    scope.run(() => {
      attachment = useAttachment(current, { client: fake.client })
    })

    await flush()
    current.value = null
    await flush()
    expect(fake.unwatched).toEqual(['a'])
    expect(attachment.state.value).toBe('idle')
    expect(attachment.localUri.value).toBeNull()

    current.value = undefined
    await flush()
    expect(fake.watched).toEqual(['a'])
    scope.stop()
  })

  test('a per-ref update still reaches the refs after a resubscribe', async () => {
    const fake = makeFakeKizunaSync(localUris({ a: 'uri-a', b: 'uri-b' }))
    const current = ref('a')
    const scope = effectScope()
    let attachment!: ReturnType<typeof useAttachment>

    scope.run(() => {
      attachment = useAttachment(current, { client: fake.client })
    })

    await flush()
    current.value = 'b'
    await flush()
    fake.emit('b', {
      state: EAttachmentState.downloading,
      progress: 42,
      localUri: null,
      error: null,
      permanent: false,
      attempts: 0,
    })
    expect(attachment.state.value).toBe('downloading')
    expect(attachment.progress.value).toBe(42)
    scope.stop()
  })

  test('a download started for the previous ref does not overwrite the current one', async () => {
    let openGateA!: () => void
    const gateA = new Promise<void>((resolve) => {
      openGateA = resolve
    })
    const fake = makeFakeKizunaSync(
      localUris({ a: null, b: 'uri-b' }),
      new Map([['a', gateA]]),
    )
    const current = ref('a')
    const scope = effectScope()
    let attachment!: ReturnType<typeof useAttachment>

    scope.run(() => {
      attachment = useAttachment(current, { client: fake.client })
    })

    await flush()
    expect(fake.downloads).toEqual(['a'])
    expect(attachment.localUri.value).toBeNull()

    current.value = 'b'
    await flush()
    expect(attachment.localUri.value).toBe('uri-b')

    openGateA()
    await flush()
    expect(attachment.localUri.value).toBe('uri-b')
    scope.stop()
  })

  test('a retry that settles after the ref changed does not fetch either ref', async () => {
    let openRetryA!: () => void
    const retryA = new Promise<void>((resolve) => {
      openRetryA = resolve
    })
    const fake = makeFakeKizunaSync(
      localUris({ a: 'uri-a', b: 'uri-b' }),
      new Map(),
      new Map([['a', retryA]]),
    )
    const current = ref('a')
    const scope = effectScope()
    let attachment!: ReturnType<typeof useAttachment>

    scope.run(() => {
      attachment = useAttachment(current, { client: fake.client })
    })

    await flush()
    attachment.retry()

    current.value = 'b'
    await flush()
    expect(attachment.localUri.value).toBe('uri-b')

    openRetryA()
    await flush()
    expect(fake.downloads).toEqual([])
    expect(attachment.localUri.value).toBe('uri-b')
    scope.stop()
  })

  test('the scope keeps its subscription until it is disposed', async () => {
    const fake = makeFakeKizunaSync(localUris({ a: 'uri-a' }))
    const current = ref('a')
    const scope = effectScope()

    scope.run(() => {
      useAttachment(current, { client: fake.client })
    })

    await flush()
    expect(fake.unwatched).toEqual([])
    scope.stop()
    expect(fake.unwatched).toEqual(['a'])

    current.value = 'b'
    await flush()
    expect(fake.watched).toEqual(['a'])
  })
})
