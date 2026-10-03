/// <reference types="bun" />
/**
 * `dispose` is what an app calls from a teardown hook, so it returns without
 * waiting for the backend to let go of its engine thread and database file.
 * The addon releases those asynchronously and answers with a promise; the
 * worker transport and the UniFFI adapter release at once and answer with
 * `void`. These pin that both shapes leave the caller on the same line, and
 * that the release waits for the calls already issued on either lane.
 *
 * A fake addon stands in for the native one: the release contract is under
 * test, not the Rust core, so the suite does not need `cargo build`.
 */

import { describe, expect, test } from 'bun:test'
import { createRustEngine } from './rust-engine'
import { noopLogger } from '../util/logger'
import type { INapiAddon, INapiEngine } from './napi-loader'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { TEngineConfig } from '../wire/types'

const CONFIG: TEngineConfig = {
  tables: { todos: { bucketColumn: 'owner_id', bucketParams: { owner_id: 'user-a' } } },
  schemaVersion: 1,
}

const NOW = '2024-01-01T00:00:00.000Z'

const idleRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('the dispose suite never syncs')),
  push: () => Promise.reject(new Error('the dispose suite never syncs')),
}

/** Answers every call with an empty success envelope and closes through the injected `close`. */
const fakeAddon = (close: () => void | Promise<void>): INapiAddon => {
  const KizunaSyncEngine = function KizunaSyncEngine(this: INapiEngine): void {
    this.call = () => JSON.stringify({ ok: true, value: null })
    this.close = close
  } as unknown as INapiAddon['KizunaSyncEngine']

  return { ping: () => 'pong', KizunaSyncEngine }
}

/** Holds every `sync` and `apply` until the test answers it; every other call answers at once. */
const holdingAddon = (close: () => void): { addon: INapiAddon; answer: (method: string) => void } => {
  const answers = new Map<string, () => void>()
  const KizunaSyncEngine = function KizunaSyncEngine(this: INapiEngine): void {
    this.call = (method: string): Promise<string> | string => {
      if (method !== 'sync' && method !== 'apply') {
        return JSON.stringify({ ok: true, value: null })
      }
      return new Promise<string>((resolve) => {
        answers.set(method, () => resolve(JSON.stringify({ ok: true, value: null })))
      })
    }
    this.close = close
  } as unknown as INapiAddon['KizunaSyncEngine']

  return {
    addon: { ping: () => 'pong', KizunaSyncEngine },
    answer: (method) => {
      answers.get(method)?.()
    },
  }
}

const engineOver = (
  close: () => void | Promise<void>,
  addon: INapiAddon = fakeAddon(close),
): ReturnType<typeof createRustEngine> =>
  createRustEngine({
    addon,
    databasePath: null,
    remote: idleRemote,
    config: CONFIG,
    clientId: 'dispose-test',
    now: () => NOW,
    uuid: () => 'mutation-1',
    logger: noopLogger,
    deps: { pollIntervalMs: 0 },
  })

describe('dispose over both close shapes', () => {
  test('a promise-returning close leaves dispose synchronous and the release pending', () => {
    let release: () => void = () => undefined
    let released = false
    const releasing = new Promise<void>((resolve) => {
      release = resolve
    })

    void releasing.then(() => {
      released = true
    })
    const engine = engineOver(() => releasing)

    expect(engine.dispose?.()).toBeUndefined()
    expect(released).toBe(false)

    release()
  })

  test('a void-returning close leaves dispose synchronous and the release done', async () => {
    let closes = 0
    const engine = engineOver(() => {
      closes += 1
    })

    // The checkpoint read the engine makes as it opens settles first, so no call is in flight.
    await Bun.sleep(1)
    expect(engine.dispose?.()).toBeUndefined()
    expect(closes).toBe(1)
  })

  test('dispose during a held sync and a held write releases the engine once both lanes drain', async () => {
    let closes = 0
    const close = (): void => {
      closes += 1
    }
    const fake = holdingAddon(close)
    const engine = engineOver(close, fake.addon)
    const syncing = engine.sync()
    const applying = engine.apply({ table: 'todos', pk: 'p1', op: 'insert', columns: { id: 'p1', owner_id: 'user-a' } })

    await Bun.sleep(1)
    expect(engine.dispose?.()).toBeUndefined()
    expect(closes).toBe(0)

    fake.answer('sync')
    await syncing
    await Bun.sleep(1)
    expect(closes).toBe(0)

    fake.answer('apply')
    await applying
    await Bun.sleep(1)
    expect(closes).toBe(1)
  })
})
