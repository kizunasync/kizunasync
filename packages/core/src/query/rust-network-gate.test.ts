/// <reference types="bun" />
/**
 * `beforeNetwork` is the host's session gate: `sync`, `pullOnce` and `pushOnce`
 * await it before their network call, so a host whose transport lives inside
 * the engine (UniFFI) can refresh the session and hand the engine its token
 * first. A refused gate rejects the call before any network call and counts as
 * a failed attempt in sync health.
 *
 * A fake addon stands in for the native one: the adapter's sequencing is under
 * test, not the Rust core, so the suite does not need `cargo build`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createRustEngine } from './rust-engine'
import type { IAppClientEngine } from './select-engine'
import { noopLogger } from '../util/logger'
import type { INapiAddon, INapiEngine } from './napi-loader'
import type { IConnectivity } from '../ports/connectivity'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { TEngineConfig, TQueryPlan } from '../wire/types'

const CONFIG: TEngineConfig = {
  tables: { todos: { bucketColumn: 'owner_id', bucketParams: { owner_id: 'user-a' } } },
  schemaVersion: 1,
}

/** A plan with no filters or orders: enough shape for the fake addon, which ignores its content. */
const EMPTY_QUERY_PLAN: TQueryPlan = { filters: [], orders: [], cardinality: 'many' }

const NOW = '2024-01-01T00:00:00.000Z'

const idleRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('the fake addon never calls the remote')),
  push: () => Promise.reject(new Error('the fake addon never calls the remote')),
}

/** The coded failure a Supabase session gate rejects with when no session can be had. */
const sessionMissing = (): Error => {
  const error = new Error('no session to sign the request with')

  ;(error as { code?: string }).code = 'AUTH_SESSION_MISSING'

  return error
}

// MARK: - Harness

type TGateHarness = {
  engine: IAppClientEngine

  /** The gate runs and the engine calls, in the order they happened. */
  steps: string[]

  /** Lets the held gate pass. */
  open: () => void
}

type TGateOptions = {
  /** What the gate does once it runs: pass when opened, or refuse at once. */
  gate: 'held' | 'refused'

  online?: boolean
}

const opened: IAppClientEngine[] = []

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.dispose?.()
  }
})

const harness = (options: TGateOptions): TGateHarness => {
  const steps: string[] = []
  let open: () => void = () => undefined
  const KizunaSyncEngine = function KizunaSyncEngine(this: INapiEngine): void {
    this.call = (method: string) => {
      // The checkpoint read the adapter makes as it opens is not a step of the sequences under test.
      if (method === 'checkpoint') {
        return JSON.stringify({ ok: true, value: { cursor: '0', soft_blocked: false } })
      }
      steps.push(method)

      return JSON.stringify({ ok: true, value: method === 'query' ? [] : null })
    }
    this.close = () => undefined
  } as unknown as INapiAddon['KizunaSyncEngine']
  const connectivity: IConnectivity = {
    isOnline: () => options.online ?? true,
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
      pollIntervalMs: 0,
      connectivity,
      beforeNetwork: () => {
        steps.push('gate')

        if (options.gate === 'refused') {
          return Promise.reject(sessionMissing())
        }
        return new Promise<void>((resolve) => {
          open = resolve
        })
      },
    },
  })

  opened.push(engine)

  return { engine, steps, open: () => open() }
}

const NETWORK_CALLS: Array<{ name: string; method: string; run: (engine: IAppClientEngine) => Promise<void> }> = [
  { name: 'sync', method: 'sync', run: (engine) => engine.sync() },
  { name: 'pullOnce', method: 'pull_once', run: (engine) => engine.pullOnce() },
  { name: 'pushOnce', method: 'push_once', run: (engine) => engine.pushOnce() },
]

// MARK: - Tests

describe('the session gate runs ahead of every network call', () => {
  test.each(NETWORK_CALLS)('$name awaits the gate before its network call', async ({ method, run }) => {
    const gated = harness({ gate: 'held' })
    const running = run(gated.engine)

    await Bun.sleep(1)
    expect(gated.steps).toEqual(['gate'])

    gated.open()
    await running
    expect(gated.steps).toEqual(['gate', method])
  })

  test.each(NETWORK_CALLS)('a refused gate fails $name before the network as a failed attempt', async ({ run }) => {
    const gated = harness({ gate: 'refused' })
    const refused: unknown = await run(gated.engine).catch((error: unknown) => error)

    expect(refused).toMatchObject({ code: 'AUTH_SESSION_MISSING' })
    expect(gated.steps).toEqual(['gate'])
    const health = gated.engine.getSyncHealth()

    expect(health.consecutiveFailures).toBe(1)
    expect(health.lastError).toMatchObject({
      code: 'AUTH_SESSION_MISSING',
      message: 'no session to sign the request with',
    })
    expect(health.attemptStartedAt).toBeNull()
  })

  test('an offline sync reaches neither the gate nor the network', async () => {
    const gated = harness({ gate: 'refused', online: false })

    await gated.engine.sync()

    expect(gated.steps).toEqual([])
    expect(gated.engine.getSyncHealth().consecutiveFailures).toBe(0)
  })

  test('a local call never runs the gate', async () => {
    const gated = harness({ gate: 'refused' })

    expect(await gated.engine.query('todos', EMPTY_QUERY_PLAN)).toEqual([])
    expect(gated.steps).toEqual(['query'])
  })
})
