/// <reference types="bun" />
/**
 * The app client orders engine calls on two lanes. A local call (a query, a
 * write, a checkpoint or journal read, an attachment-queue row, `setBucket`,
 * the access token) waits only for the local calls issued before it, so it
 * answers while a pull or a push awaits the network. A network call waits for
 * the network call before it and for the local calls issued before it, so it
 * carries every write and bucket value the app issued first. `reset` and
 * `seedCheckpoint` wait for both lanes, and every later call waits for them.
 *
 * A fake addon holds the calls a test names, so each ordering below is exact.
 * The last suite drives the native addon when it is built.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { byOwner, defineConfig } from '../config/config'
import { createKizunaSync, type IKizunaSync } from './kizunasync'
import { loadNapiAddon, type INapiAddon, type INapiEngine } from './napi-loader'
import { createRustEngine } from './rust-engine'
import type { IAppClientEngine } from './select-engine'
import { createTempDatabase } from '../testing/temp-database'
import { noopLogger } from '../util/logger'
import type { IFileStore } from '../ports/file-store'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { ITransfer } from '../ports/transfer'
import { EEngineErrorCode, EVerdictKind, TEngineError, type TEngineConfig, type TEngineDeps, type TPullResponse, type TQueryPlan } from '../wire/types'

const NOW = '2024-01-01T00:00:00.000Z'

/** A plan with no filters or orders: enough shape for the fake addon, which ignores its content. */
const EMPTY_QUERY_PLAN: TQueryPlan = { filters: [], orders: [], cardinality: 'many' }

/** How long a test waits for an answer before it fails instead of hanging. */
const STUCK_AFTER_MS = 500

const idleRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('the fake addon never calls the remote')),
  push: () => Promise.reject(new Error('the fake addon never calls the remote')),
}

const ownerConfig = (): TEngineConfig => ({
  tables: { todos: { bucketColumn: 'owner_id', bucketParams: { owner_id: 'user-a' } } },
  schemaVersion: 1,
})

const INSERT = { table: 'todos', pk: 'p1', op: 'insert', columns: { id: 'p1', owner_id: 'user-a' } } as const

const BUCKET_UNSET_FAILURE = JSON.stringify({
  ok: false,
  error: { kind: 'bucket_unset', message: 'unknown bucket key "team_id"' },
})

// MARK: - A fake addon that holds calls

/** The value a call the fake does not script answers, shaped like the engine's. */
const valueOf = (method: string): unknown => {
  switch (method) {
    case 'query':
    case 'rejections':
    case 'overwrites':
    case 'reset':
    case 'attachment_pending':
    case 'attachment_orphaned':
      return []
    case 'outbox_depth':
      return 0
    case 'checkpoint':
      return { cursor: '0', soft_blocked: false, soft_block_reason: null }
    default:
      return null
  }
}

type TArrival = { method: string; params: Record<string, unknown> }

type TLaneAddon = {
  addon: INapiAddon

  /** Every call in the order it reached the addon. */
  arrivals: TArrival[]

  /** The methods of `arrivals`. */
  reached: () => string[]

  /** Answers the held call of `method`. */
  release: (method: string) => void
}

/** Holds every call of a method in `held` until the test releases it; `script` answers a call with a fixed envelope. */
const laneAddon = (
  held: readonly string[] = [],
  script: (arrival: TArrival) => string | null = () => null,
): TLaneAddon => {
  const arrivals: TArrival[] = []
  const releases = new Map<string, () => void>()
  let hasOpened = false
  const KizunaSyncEngine = function KizunaSyncEngine(this: INapiEngine): void {
    this.call = (method: string, paramsJson: string): Promise<string> => {
      const arrival = { method, params: JSON.parse(paramsJson) as Record<string, unknown> }
      const answer = script(arrival) ?? JSON.stringify({ ok: true, value: valueOf(method) })

      // The adapter's first call is the checkpoint read it makes as it opens, which no ordering below is about.
      if (!hasOpened) {
        hasOpened = true

        return Promise.resolve(answer)
      }
      arrivals.push(arrival)

      if (!held.includes(method)) {
        return Promise.resolve(answer)
      }
      return new Promise<string>((resolve) => {
        releases.set(method, () => resolve(answer))
      })
    }
    this.close = () => undefined
  } as unknown as INapiAddon['KizunaSyncEngine']

  return {
    addon: { ping: () => 'pong', KizunaSyncEngine },
    arrivals,
    reached: () => arrivals.map((arrival) => arrival.method),
    release: (method) => {
      releases.get(method)?.()
    },
  }
}

const opened: IAppClientEngine[] = []

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.dispose?.()
  }
})

const engineOver = (
  addon: INapiAddon,
  config: TEngineConfig = ownerConfig(),
  deps: TEngineDeps = {},
): IAppClientEngine => {
  const engine = createRustEngine({
    addon,
    databasePath: null,
    remote: idleRemote,
    config,
    clientId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    uuid: () => '00000000-0000-4000-8000-000000000002',
    logger: noopLogger,
    deps: { pollIntervalMs: 0, ...deps },
  })

  opened.push(engine)

  return engine
}

/** Lets every call the engine can issue now reach the addon. */
const settle = (): Promise<void> => Bun.sleep(1)

/** Settles with `pending`, or rejects once it has waited `STUCK_AFTER_MS`. */
const within = async <T>(pending: Promise<T>): Promise<T> =>
  Promise.race([
    pending,
    Bun.sleep(STUCK_AFTER_MS).then((): never => {
      throw new Error(`no answer within ${STUCK_AFTER_MS} ms`)
    }),
  ])

// MARK: - Local calls

describe('local calls never wait for the network lane', () => {
  test('a query, a write and the local reads answer while a sync awaits the network', async () => {
    const fake = laneAddon(['sync'])
    const engine = engineOver(fake.addon)
    const syncing = engine.sync()

    await settle()
    expect(fake.reached()).toEqual(['sync'])

    await within(
      Promise.all([
        engine.query('todos', EMPTY_QUERY_PLAN),
        engine.apply(INSERT),
        engine.getOutboxDepth(),
        engine.getCheckpoint(),
        engine.rejections(),
        engine.overwrites(),
      ]),
    )
    expect(fake.reached()).toEqual(['sync', 'query', 'apply', 'outbox_depth', 'checkpoint', 'rejections', 'overwrites'])

    fake.release('sync')
    await within(syncing)
  })

  test('a setBucket and an access token answer while a pull awaits the network', async () => {
    const fake = laneAddon(['pull_once'])
    const engine = engineOver(fake.addon)
    const pulling = engine.pullOnce()

    await settle()
    engine.setBucket({ owner_id: 'user-b' })
    await within(engine.setRemoteAccessToken?.('token-b') ?? Promise.resolve())

    expect(fake.reached()).toEqual(['pull_once', 'set_bucket', 'set_access_token'])

    fake.release('pull_once')
    await within(pulling)
  })

  test('an attachment-queue call answers while the push half of a sync awaits the network', async () => {
    const fake = laneAddon(['sync_push'])
    const config: TEngineConfig = {
      tables: {
        todos: {
          bucketColumn: 'owner_id',
          bucketParams: { owner_id: 'user-a' },
          attachments: { photo: { storageBucket: 'photos', ownerColumn: 'owner_id' } },
        },
      },
      schemaVersion: 1,
    }
    const engine = engineOver(fake.addon, config, {
      fileStore: {} as unknown as IFileStore,
      transfer: {} as unknown as ITransfer,
    })
    const syncing = engine.sync()

    await settle()
    expect(fake.reached()).toContain('sync_push')

    expect(await within(engine.attachments?.getStatus('photos/p1.jpg') ?? Promise.resolve(null))).toBeNull()
    expect(fake.reached().at(-1)).toBe('attachment_get')

    fake.release('sync_push')
    await within(syncing)
  })
})

// MARK: - Network calls

describe('a network call carries the calls issued before it', () => {
  test('a push waits for the write issued before it', async () => {
    const fake = laneAddon(['apply'])
    const engine = engineOver(fake.addon)
    const applying = engine.apply(INSERT)
    const pushing = engine.pushOnce()

    await settle()
    expect(fake.reached()).toEqual(['apply'])

    fake.release('apply')
    await within(Promise.all([applying, pushing]))
    expect(fake.reached()).toEqual(['apply', 'push_once'])
  })

  test('a pull waits for the sync issued before it, while a query issued between them answers', async () => {
    const fake = laneAddon(['sync'])
    const engine = engineOver(fake.addon)
    const syncing = engine.sync()
    const pulling = engine.pullOnce()

    await within(engine.query('todos', EMPTY_QUERY_PLAN))
    await settle()
    expect(fake.reached().sort()).toEqual(['query', 'sync'])

    fake.release('sync')
    await within(Promise.all([syncing, pulling]))
    expect(fake.reached().at(-1)).toBe('pull_once')
  })
})

// MARK: - Both lanes

describe('reset and seedCheckpoint wait for both lanes', () => {
  const barriers: Array<{ name: string; method: string; run: (engine: IAppClientEngine) => Promise<void> }> = [
    { name: 'reset', method: 'reset', run: (engine) => engine.reset() },
    { name: 'seedCheckpoint', method: 'seed_checkpoint', run: (engine) => engine.seedCheckpoint('7') },
  ]

  test.each(barriers)('$name waits for both lanes, and every later call waits for it', async ({ method, run }) => {
    const fake = laneAddon(['sync', 'apply', method])
    const engine = engineOver(fake.addon)
    const syncing = engine.sync()
    const applying = engine.apply(INSERT)

    await settle()
    expect(fake.reached().sort()).toEqual(['apply', 'sync'])

    const barrier = run(engine)
    const querying = engine.query('todos', EMPTY_QUERY_PLAN)
    const pulling = engine.pullOnce()

    fake.release('sync')
    await settle()
    expect(fake.reached().sort()).toEqual(['apply', 'sync'])

    fake.release('apply')
    await settle()
    expect(fake.reached().slice(2)).toEqual([method])

    fake.release(method)
    await within(Promise.all([syncing, applying, barrier, querying, pulling]))
    expect(fake.reached().slice(3).sort()).toEqual(['pull_once', 'query'])
  })
})

// MARK: - setBucket

describe('setBucket mirrors the kernel rule', () => {
  test('the value reaches every table bucketed on the key, and no other table', async () => {
    const config: TEngineConfig = {
      tables: {
        todos: { bucketColumn: 'owner_id', bucketParams: { owner_id: '' } },
        notes: { bucketColumn: 'owner_id' },
        boards: { bucketColumn: 'team_id', bucketParams: { team_id: '' } },
        tags: { bucketColumn: '' },
      },
      schemaVersion: 1,
    }
    const fake = laneAddon()
    const engine = engineOver(fake.addon, config)

    engine.setBucket({ owner_id: 'user-b' })
    await within(engine.query('todos', EMPTY_QUERY_PLAN))

    expect(config.tables.todos?.bucketParams).toEqual({ owner_id: 'user-b' })
    expect(config.tables.notes?.bucketParams).toEqual({ owner_id: 'user-b' })
    expect(config.tables.boards?.bucketParams).toEqual({ team_id: '' })
    expect(config.tables.tags?.bucketParams).toBeUndefined()
    expect(fake.arrivals[0]).toEqual({
      method: 'set_bucket',
      params: { params: { owner_id: 'user-b' }, now: NOW, now_ms: Date.parse(NOW) },
    })
  })

  test('an unknown key changes no table, and the next call re-throws the kernel refusal once', async () => {
    const config = ownerConfig()
    const fake = laneAddon([], (arrival) => (arrival.method === 'set_bucket' ? BUCKET_UNSET_FAILURE : null))
    const engine = engineOver(fake.addon, config)

    engine.setBucket({ owner_id: 'user-b', team_id: 't1' })

    expect(config.tables.todos?.bucketParams).toEqual({ owner_id: 'user-a' })
    const refused: unknown = await within(engine.query('todos', EMPTY_QUERY_PLAN)).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(TEngineError)
    expect((refused as TEngineError).code).toBe(EEngineErrorCode.BUCKET_UNSET)
    expect(await within(engine.query('todos', EMPTY_QUERY_PLAN))).toEqual([])
    expect(fake.reached()).toEqual(['set_bucket', 'query'])
  })

  test('a network call issued first after a failed setBucket is the one call that re-throws it', async () => {
    const fake = laneAddon([], (arrival) => (arrival.method === 'set_bucket' ? BUCKET_UNSET_FAILURE : null))
    const engine = engineOver(fake.addon)

    engine.setBucket({ team_id: 't1' })
    const [pulled, queried] = await within(Promise.allSettled([engine.pullOnce(), engine.query('todos', EMPTY_QUERY_PLAN)]))

    expect(pulled.status).toBe('rejected')
    expect(pulled.status === 'rejected' ? (pulled.reason as TEngineError).code : null).toBe(
      EEngineErrorCode.BUCKET_UNSET,
    )
    expect(queried.status).toBe('fulfilled')
    expect(fake.reached()).toEqual(['set_bucket', 'query'])
  })
})

// MARK: - The native addon

const addon = loadNapiAddon()

/** What a local call may take while a sync awaits the remote. */
const LOCAL_CALL_BUDGET_MS = 50

const EMPTY_PULL: TPullResponse = { cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }

const appConfig = defineConfig({
  tables: { items: { sync: 'read-write', bucket: byOwner('user_id') } },
})

describe.skipIf(addon === null)('createKizunaSync answers local calls while a sync awaits the remote', () => {
  const open: IKizunaSync[] = []

  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.dispose()
    }
  })

  test('a write and a query each answer in under 50 ms while the pull is held', async () => {
    let signalEntered: () => void = () => undefined
    let release: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const remote: IProtocolRemote = {
      pull: async () => {
        signalEntered()
        await released

        return EMPTY_PULL
      },
      push: async (request) => ({
        verdicts: request.batch.mutations.map((mutation) => ({
          mutation_id: mutation.mutation_id,
          verdict: EVerdictKind.applied,
        })),
      }),
    }
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, appConfig, { pollIntervalMs: 0 })

    open.push(kizunasync)
    kizunasync.setBucket({ user_id: 'u1' })
    const syncing = kizunasync.sync()

    try {
      await within(entered)
      let started = performance.now()

      await within(kizunasync.from('items').insert({ id: 'p1', title: 'works on a plane', user_id: 'u1' }))
      const writeMs = performance.now() - started

      started = performance.now()
      const { data } = await within(Promise.resolve(kizunasync.from('items').select()))
      const readMs = performance.now() - started

      expect(writeMs).toBeLessThan(LOCAL_CALL_BUDGET_MS)
      expect(readMs).toBeLessThan(LOCAL_CALL_BUDGET_MS)
      expect(data).toMatchObject([{ id: 'p1', title: 'works on a plane' }])
    } finally {
      release()
    }
    await within(syncing)
  })
})
