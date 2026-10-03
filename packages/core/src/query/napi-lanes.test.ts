/// <reference types="bun" />
/**
 * Local work on the N-API addon never waits for the network. The engine thread
 * runs every call as its own task, so a query or a write answers while a sync
 * awaits the promise the JavaScript remote returns, a local call answered
 * before a network call reaches it, and `close` waits for the sync to answer.
 * The app client keeps issue order on top of that: a `setBucket` reaches the
 * pull issued after it, and a write reaches the push issued after it.
 *
 * Skipped wholesale when the addon is not built (`cargo build -p kizunasync-napi`):
 * without it there is no engine thread to reach.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { byOwner, defineConfig } from '../config/config'
import { parseCallEnvelope } from './engine-envelope'
import { createKizunaSync, type IKizunaSync } from './kizunasync'
import { loadNapiAddon, type INapiEngine } from './napi-loader'
import { bridgeRemote, isPullRequest, isPushRequest } from './remote-bridge'
import { toRustConfig } from './rust-engine'
import { createTempDatabase } from '../testing/temp-database'
import type { IProtocolRemote } from '../ports/protocol-remote'
import { EVerdictKind, type TEngineConfig, type TPullRequest, type TPullResponse, type TPushRequest, type TPushResponse } from '../wire/types'

const addon = loadNapiAddon()

/** What a local call may take while a sync awaits the remote. */
const LOCAL_CALL_BUDGET_MS = 50
/** How long a test waits for an answer before it fails instead of hanging. */
const STUCK_AFTER_MS = 1_000
const NOW = '2024-01-01T00:00:00.000Z'

const ENGINE_CONFIG: TEngineConfig = {
  schemaVersion: 1,
  tables: { items: { bucketColumn: 'user_id', bucketParams: { user_id: 'u1' } } },
}

const EMPTY_PULL: TPullResponse = {
  cursor: '0',
  has_more: false,
  rows: [],
  signal: null,
  tombstones: [],
}

const applyAll = (request: TPushRequest): TPushResponse => ({
  verdicts: request.batch.mutations.map((mutation) => ({
    mutation_id: mutation.mutation_id,
    verdict: EVerdictKind.applied,
  })),
})

// MARK: - A remote the test holds

interface IHeldRemote extends IProtocolRemote {
  readonly pulls: TPullRequest[]
  readonly pushes: TPushRequest[]

  /** Settles once the first pull reaches the remote. */
  readonly entered: Promise<void>

  /** Answers the held pulls and every later one. */
  release(): void
}

/** Every pull waits until `release`; pushes apply at once. */
const heldRemote = (): IHeldRemote => {
  const pulls: TPullRequest[] = []
  const pushes: TPushRequest[] = []
  let signalEntered: () => void = () => undefined
  let release: () => void = () => undefined
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })

  return {
    pulls,
    pushes,
    entered,
    release: () => release(),
    pull: async (request) => {
      pulls.push(request)
      signalEntered()
      await released

      return EMPTY_PULL
    },
    push: async (request) => {
      pushes.push(request)

      return applyAll(request)
    },
  }
}

// MARK: - Calls on the addon

/** Settles with `pending`, or rejects once it has waited `STUCK_AFTER_MS`. */
const within = async <T>(pending: Promise<T>): Promise<T> =>
  Promise.race([
    pending,
    Bun.sleep(STUCK_AFTER_MS).then((): never => {
      throw new Error(`no answer within ${STUCK_AFTER_MS} ms`)
    }),
  ])

/** The answer `run` settles with and the milliseconds it took. */
const timed = async <T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now()
  const value = await within(run())

  return { value, ms: performance.now() - started }
}

const call = async (engine: INapiEngine, method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
  parseCallEnvelope(await engine.call(method, JSON.stringify({ ...params, now: NOW, now_ms: Date.parse(NOW) })))

const insertOf = (pk: string): Record<string, unknown> => ({
  table: 'items',
  pk,
  op: 'insert',
  columns: { id: pk, user_id: 'u1', title: 'works on a plane' },
  mutation_id: crypto.randomUUID(),
})

const BUCKETS_U1 = [{ table: 'items', params: { user_id: 'u1' } }]
const BUCKETS_U2 = [{ table: 'items', params: { user_id: 'u2' } }]

describe.skipIf(addon === null)('the addon answers local calls while a sync awaits the remote', () => {
  const open: INapiEngine[] = []

  afterEach(async () => {
    while (open.length > 0) {
      await open.pop()?.close()
    }
  })

  const start = (remote: IProtocolRemote): INapiEngine => {
    if (addon === null) {
      throw new Error('the native addon is required for this suite')
    }
    const engine = new addon.KizunaSyncEngine(
      JSON.stringify(toRustConfig(ENGINE_CONFIG, 'napi-lanes-client')),
      null,
      bridgeRemote((request) => remote.pull(request), isPullRequest),
      bridgeRemote((request) => remote.push(request), isPushRequest),
      () => undefined,
    )

    open.push(engine)

    return engine
  }

  test('a query and an apply answer in under 50 ms while a sync awaits the held remote', async () => {
    const remote = heldRemote()
    const engine = start(remote)
    let isSynced = false
    const syncing = call(engine, 'sync').then(() => {
      isSynced = true
    })

    try {
      await within(remote.entered)
      const applied = await timed(() => call(engine, 'apply', insertOf('p1')))
      const queried = await timed(() => call(engine, 'query', { table: 'items', plan: {} }))

      expect(applied.ms).toBeLessThan(LOCAL_CALL_BUDGET_MS)
      expect(queried.ms).toBeLessThan(LOCAL_CALL_BUDGET_MS)
      expect(queried.value).toMatchObject([{ id: 'p1', title: 'works on a plane' }])
      expect(isSynced).toBe(false)
    } finally {
      remote.release()
    }
    await within(syncing)
    expect(isSynced).toBe(true)
  })

  test('a setBucket answered while a sync awaits the remote reaches the pull issued after it', async () => {
    const remote = heldRemote()
    const engine = start(remote)
    const syncing = call(engine, 'sync')
    let pulling: Promise<unknown> = Promise.resolve()

    try {
      await within(remote.entered)
      await within(call(engine, 'set_bucket', { params: { user_id: 'u2' } }))
      pulling = call(engine, 'pull_once')
    } finally {
      remote.release()
    }
    await within(Promise.all([syncing, pulling]))

    expect(remote.pulls[0]?.buckets).toEqual(BUCKETS_U1)
    expect(remote.pulls.length).toBeGreaterThan(1)
    expect(remote.pulls.slice(1).map((request) => request.buckets)).toEqual(
      remote.pulls.slice(1).map(() => BUCKETS_U2),
    )
  })

  test('an apply answered while a sync awaits the remote reaches the push issued after it', async () => {
    const remote = heldRemote()
    const engine = start(remote)
    const syncing = call(engine, 'sync')
    let pushing: Promise<unknown> = Promise.resolve()

    try {
      await within(remote.entered)
      await within(call(engine, 'apply', insertOf('p1')))
      pushing = call(engine, 'push_once')
    } finally {
      remote.release()
    }
    await within(Promise.all([syncing, pushing]))

    expect(remote.pushes.map((request) => request.batch.mutations.map((mutation) => mutation.pk))).toEqual([['p1']])
    expect(await call(engine, 'outbox_depth')).toBe(0)
  })

  test('close waits for a sync that awaits the remote, and the sync answers', async () => {
    const remote = heldRemote()
    const engine = start(remote)
    const syncing = call(engine, 'sync')
    let isClosed = false

    await within(remote.entered)
    const closing = Promise.resolve(engine.close()).then(() => {
      isClosed = true
    })

    await Bun.sleep(LOCAL_CALL_BUDGET_MS)
    expect(isClosed).toBe(false)

    remote.release()
    expect(await within(syncing)).toBeNull()
    await within(closing)
    expect(isClosed).toBe(true)
  })
})

// MARK: - Issue order through the app client

const appConfig = defineConfig({
  tables: { items: { sync: 'read-write', bucket: byOwner('user_id') } },
})

describe.skipIf(addon === null)('createKizunaSync keeps issue order on the addon', () => {
  const open: IKizunaSync[] = []

  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.dispose()
    }
  })

  const start = (remote: IProtocolRemote): IKizunaSync => {
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, appConfig, { pollIntervalMs: 0 })

    open.push(kizunasync)
    kizunasync.setBucket({ user_id: 'u1' })

    return kizunasync
  }

  test('a setBucket reaches the pull issued right after it', async () => {
    const remote = heldRemote()
    const kizunasync = start(remote)

    remote.release()
    kizunasync.setBucket({ user_id: 'u2' })
    await within(kizunasync.pullOnce())

    expect(remote.pulls.map((request) => request.buckets)).toEqual([BUCKETS_U2])
  })

  test('a write reaches the push issued right after it', async () => {
    const remote = heldRemote()
    const kizunasync = start(remote)
    const inserting = kizunasync.from('items').insert({ id: 'p1', title: 'works on a plane', user_id: 'u1' })

    await within(kizunasync.pushOnce())
    await inserting

    expect(remote.pushes.map((request) => request.batch.mutations.map((mutation) => mutation.pk))).toEqual([['p1']])
  })
})
