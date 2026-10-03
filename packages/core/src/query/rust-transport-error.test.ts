/// <reference types="bun" />
/**
 * A remote failure crosses the NAPI/UniFFI bridge twice: outbound as JSON when
 * the injected remote rejects, and back as an envelope when Rust re-raises it.
 * `retryable` survives both trips because the dead-letter budget depends on it.
 * `code` has to survive them too: public boundaries expose stable
 * machine-readable codes and consumers never classify by message text. An app
 * catching an `AUTH_SESSION_TIMEOUT` reads the same field on every bridge.
 *
 * A fake addon stands in for the native one. The bridges are under test, not
 * the Rust core; the suite does not need `cargo build`.
 */

import { describe, expect, test } from 'bun:test'
import { createRustEngine } from './rust-engine'
import { noopLogger } from '../util/logger'
import type { INapiAddon, INapiEngine } from './napi-loader'
import type { IProtocolRemote } from '../ports/protocol-remote'
import { EEngineErrorCode, TEngineError, type TEngineConfig } from '../wire/types'

const CONFIG: TEngineConfig = {
  tables: { todos: { bucketColumn: 'owner_id', bucketParams: { owner_id: 'user-a' } } },
  schemaVersion: 1,
}

const NOW = '2024-01-01T00:00:00.000Z'

/** A pull request as the engine sends it, so the bridge hands it to the remote. */
const PULL_REQUEST = JSON.stringify({ buckets: [{ table: 'todos', params: { owner_id: 'user-a' } }], cursor: '0', schema_version: 1 })

type TCapturedAddon = {
  addon: INapiAddon

  /** The outbound bridge Rust would call to run a pull. */
  pull: () => (requestJson: string) => Promise<string>
}

/**
 * Fails every engine call with the envelope Rust produces for a remote error,
 * and hands back the pull bridge it was constructed with.
 */
const fakeAddon = (envelope: unknown): TCapturedAddon => {
  let captured: ((requestJson: string) => Promise<string>) | null = null
  const KizunaSyncEngine = function KizunaSyncEngine(
    this: INapiEngine,
    _configJson: string,
    _databasePath: string | null,
    pull: (requestJson: string) => Promise<string>,
  ): void {
    captured = pull
    this.call = () => JSON.stringify(envelope)
    this.close = () => undefined
  } as unknown as INapiAddon['KizunaSyncEngine']

  return {
    addon: { ping: () => 'pong', KizunaSyncEngine },
    pull: () => {
      if (captured === null) {
        throw new Error('the engine was never constructed')
      }
      return captured
    },
  }
}

/**
 * How late the first call this stand-in takes settles, in milliseconds. Long
 * enough that an unserialized second call reaches the engine first.
 */
const REORDER_DELAY_MS = 20

type TArrival = { method: string; params: Record<string, unknown> }

/**
 * A stand-in for the reordering the NAPI bridge cannot avoid: `#[napi] pub async
 * fn call` sends from a tokio task napi-rs spawns, so a later call can reach the
 * engine's command channel first. Here the first call settles late and every
 * later one settles at once, and `arrivals` records the order the engine sees.
 */
const reorderingAddon = (): { addon: INapiAddon; arrivals: TArrival[] } => {
  const arrivals: TArrival[] = []
  let taken = false
  const KizunaSyncEngine = function KizunaSyncEngine(this: INapiEngine): void {
    this.call = (method: string, paramsJson: string): Promise<string> => {
      // The checkpoint read the adapter makes as it opens is not one of the calls whose order is under test.
      if (method === 'checkpoint') {
        return Promise.resolve(JSON.stringify({ ok: true, value: { cursor: '0', soft_blocked: false } }))
      }
      const late = !taken

      taken = true

      return new Promise<string>((resolve) => {
        setTimeout(
          () => {
            arrivals.push({ method, params: JSON.parse(paramsJson) as Record<string, unknown> })
            resolve(JSON.stringify({ ok: true, value: null }))
          },
          late ? REORDER_DELAY_MS : 0,
        )
      })
    }
    this.close = () => undefined
  } as unknown as INapiAddon['KizunaSyncEngine']

  return { addon: { ping: () => 'pong', KizunaSyncEngine }, arrivals }
}

const engineOver = (addon: INapiAddon, remote: IProtocolRemote): ReturnType<typeof createRustEngine> =>
  createRustEngine({
    addon,
    databasePath: null,
    remote,
    config: CONFIG,
    clientId: 'transport-error-test',
    now: () => NOW,
    uuid: () => 'mutation-1',
    logger: noopLogger,
    deps: { pollIntervalMs: 0 },
  })

const rejectingRemote = (failure: unknown): IProtocolRemote => ({
  pull: () => Promise.reject(failure),
  push: () => Promise.reject(failure),
})

const codedFailure = (): Error => {
  const error = new Error('the session was not available before the deadline')

  ;(error as { code?: string; retryable?: boolean }).code = 'AUTH_SESSION_TIMEOUT'
  ;(error as { retryable?: boolean }).retryable = true

  return error
}

describe('rust bridge: the outbound direction', () => {
  test('a remote failure carries its code and retryable flag to Rust', async () => {
    const fake = fakeAddon({ ok: true, value: null })
    const engine = engineOver(fake.addon, rejectingRemote(codedFailure()))
    const answer = JSON.parse(await fake.pull()(PULL_REQUEST)) as {
      ok: boolean
      message: string
      retryable: boolean
      code?: string
    }

    expect(answer).toEqual({
      ok: false,
      message: 'the session was not available before the deadline',
      retryable: true,
      code: 'AUTH_SESSION_TIMEOUT',
    })
    engine.dispose?.()
  })

  test('a failure without a code omits the field rather than sending null', async () => {
    const fake = fakeAddon({ ok: true, value: null })
    const engine = engineOver(fake.addon, rejectingRemote(new Error('network unreachable')))
    const answer = JSON.parse(await fake.pull()(PULL_REQUEST)) as Record<string, unknown>

    expect(answer).toEqual({ ok: false, message: 'network unreachable', retryable: true })
    engine.dispose?.()
  })
})

describe('rust bridge: the return direction', () => {
  test('a remote envelope rebuilds an Error keeping code and retryable', async () => {
    const fake = fakeAddon({
      ok: false,
      error: {
        kind: 'remote',
        message: 'the session was not available before the deadline',
        code: 'AUTH_SESSION_TIMEOUT',
        retryable: true,
      },
    })
    const engine = engineOver(fake.addon, rejectingRemote(codedFailure()))
    const caught = (await engine.sync().then(
      () => null,
      (error: unknown) => error,
    )) as (Error & { code?: string; retryable?: boolean }) | null

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.code).toBe('AUTH_SESSION_TIMEOUT')
    expect(caught?.retryable).toBe(true)
    engine.dispose?.()
  })

  test('an envelope without a code leaves the rebuilt Error without one', async () => {
    const fake = fakeAddon({
      ok: false,
      error: { kind: 'remote', message: 'network unreachable', retryable: true },
    })
    const engine = engineOver(fake.addon, rejectingRemote(new Error('network unreachable')))
    const caught = (await engine.sync().then(
      () => null,
      (error: unknown) => error,
    )) as (Error & { code?: string }) | null

    expect(caught?.message).toBe('network unreachable')
    expect(caught?.code).toBeUndefined()
    engine.dispose?.()
  })

  // The wasm bridge answers a call made before create() with this envelope, and the browser worker reaches that path.
  test('an engine_unavailable envelope rebuilds the typed ENGINE_UNAVAILABLE error', async () => {
    const fake = fakeAddon({
      ok: false,
      error: {
        kind: 'engine_unavailable',
        code: 'ENGINE_UNAVAILABLE',
        message: 'create() has not been called on this engine',
        retryable: false,
      },
    })
    const engine = engineOver(fake.addon, rejectingRemote(new Error('unused')))
    const caught = (await engine.sync().then(
      () => null,
      (error: unknown) => error,
    )) as TEngineError | null

    expect(caught).toBeInstanceOf(TEngineError)
    expect(caught?.code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
    expect(caught?.message).toBe('create() has not been called on this engine')
    engine.dispose?.()
  })
})

describe('rust bridge call ordering', () => {
  // `setBucket` is synchronous in the app client, so the wrapper is the only place its call can be ordered ahead of the sync that follows it.
  test('a sync cannot overtake the set_bucket issued before it', async () => {
    const fake = reorderingAddon()
    const engine = engineOver(fake.addon, rejectingRemote(new Error('unused')))

    engine.setBucket({ owner_id: 'user-b' })
    await engine.sync()

    expect(fake.arrivals.map((arrival) => arrival.method)).toEqual(['set_bucket', 'sync'])
    expect(fake.arrivals[0]?.params.params).toEqual({ owner_id: 'user-b' })
    engine.dispose?.()
  })

  // Two calls issued in the same tick: the second one must wait for the same settlement as the first, or it reaches the bridge while the fire-and-forget `set_bucket` is still in flight.
  test('neither of two calls issued in one tick overtakes the set_bucket before them', async () => {
    const fake = reorderingAddon()
    const engine = engineOver(fake.addon, rejectingRemote(new Error('unused')))

    engine.setBucket({ owner_id: 'user-b' })
    await Promise.all([engine.pullOnce(), engine.pushOnce()])

    const methods = fake.arrivals.map((arrival) => arrival.method)

    expect(methods[0]).toBe('set_bucket')
    expect([...methods.slice(1)].sort()).toEqual(['pull_once', 'push_once'])
    engine.dispose?.()
  })
})
