/// <reference types="bun" />
// MARK: - Split sync

/**
 * With an attachment queue the app client runs the kernel's `sync` as two
 * halves and moves the bytes between them. The split keeps the kernel's own
 * rule: a push failure still pulls unless it is a retryable transport failure,
 * the push failure is what the call reports, and the queue is driven only after
 * a clean push.
 *
 * A fake addon stands in for the native one: the adapter's sequencing is under
 * test, not the Rust core, so the suite does not need `cargo build`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createRustEngine } from './rust-engine'
import { noopLogger } from '../util/logger'
import type { INapiAddon, INapiEngine } from './napi-loader'
import type { IAppClientEngine } from './select-engine'
import type { IFileStore } from '../ports/file-store'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { ITransfer } from '../ports/transfer'
import { EEngineErrorCode, TEngineError, type TEngineConfig } from '../wire/types'

const CONFIG: TEngineConfig = {
  tables: { todos: { bucketColumn: 'owner_id', bucketParams: { owner_id: 'user-a' } } },
  schemaVersion: 1,
}

const NOW = '2024-01-01T00:00:00.000Z'

const idleRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('the fake addon never calls the remote')),
  push: () => Promise.reject(new Error('the fake addon never calls the remote')),
}

/** The queue never reaches the byte ports here: the fake store lists no pending and no orphaned row. */
const unusedFileStore = {} as unknown as IFileStore

const unusedTransfer = {} as unknown as ITransfer

/** The engine methods the split sync itself calls, in the order a clean run calls them. */
const SYNC_METHODS = ['sync_push', 'outbox_depth', 'attachment_pending', 'attachment_orphaned', 'sync_pull']

type TCallError = { kind: string; message: string; code?: string; retryable?: boolean }

type TScript = Partial<Record<string, string>>

const ok = (value: unknown): string => JSON.stringify({ ok: true, value })

const failure = (error: TCallError): string => JSON.stringify({ ok: false, error })

const PERMANENT: TCallError = { kind: 'remote', message: 'duplicate key', code: '23505', retryable: false }

const RETRYABLE: TCallError = { kind: 'remote', message: 'network down', retryable: true }

/** What the fake addon answers: the script first, then a store that is not soft-blocked, an empty queue and an outbox the push drained. */
const answer = (method: string, script: TScript): string => {
  const scripted = script[method]

  if (scripted !== undefined) {
    return scripted
  }
  if (method === 'checkpoint') {
    return ok({ cursor: '0', soft_blocked: false })
  }
  if (method === 'attachment_pending' || method === 'attachment_orphaned') {
    return ok([])
  }
  return method === 'outbox_depth' ? ok(0) : ok(null)
}

// MARK: - Harness

type TSplitClient = {
  engine: IAppClientEngine

  /** The split sync's own engine calls, in order, without the queue's construction-time recovery. */
  syncCalls: () => string[]
}

const opened: IAppClientEngine[] = []

const splitClient = async (script: TScript = {}): Promise<TSplitClient> => {
  const calls: string[] = []
  const KizunaSyncEngine = function KizunaSyncEngine(this: INapiEngine): void {
    this.call = (method: string) => {
      calls.push(method)

      return answer(method, script)
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
    logger: noopLogger,
    deps: { pollIntervalMs: 0, fileStore: unusedFileStore, transfer: unusedTransfer },
  })

  opened.push(engine)
  // The queue reaches Storage only under a session, so the client signs in the way a host does.
  await engine.setRemoteAccessToken?.('token')

  return { engine, syncCalls: () => calls.filter((method) => SYNC_METHODS.includes(method)) }
}

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.dispose?.()
  }
})

// MARK: - Tests

describe('the split sync keeps the kernel rule', () => {
  test('a clean push drives the queue between the two halves', async () => {
    const client = await splitClient()

    await client.engine.sync()

    expect(client.syncCalls()).toEqual(SYNC_METHODS)
  })

  test('a clean push that leaves writes queued keeps the queue parked', async () => {
    const client = await splitClient({ outbox_depth: ok(1) })

    await client.engine.sync()

    expect(client.syncCalls()).toEqual(['sync_push', 'outbox_depth', 'sync_pull'])
  })

  test('a permanent transport failure still pulls, skips the queue, and is the failure reported', async () => {
    const client = await splitClient({ sync_push: failure(PERMANENT) })

    await expect(client.engine.sync()).rejects.toMatchObject({
      message: 'duplicate key',
      code: '23505',
      retryable: false,
    })

    expect(client.syncCalls()).toEqual(['sync_push', 'sync_pull'])
  })

  test('a retryable transport failure stops before the pull', async () => {
    const client = await splitClient({ sync_push: failure(RETRYABLE) })

    await expect(client.engine.sync()).rejects.toMatchObject({ message: 'network down', retryable: true })

    expect(client.syncCalls()).toEqual(['sync_push'])
  })

  test('a protocol fault is not a transport failure, so the pull still runs', async () => {
    const client = await splitClient({
      sync_push: failure({ kind: 'protocol', message: 'verdict count mismatch', code: 'VERDICT_BIJECTION' }),
    })

    const error: unknown = await client.engine.sync().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TEngineError)
    expect((error as TEngineError).code).toBe(EEngineErrorCode.VERDICT_BIJECTION)
    expect(client.syncCalls()).toEqual(['sync_push', 'sync_pull'])
  })

  test('a typed error the catalog calls retryable is not a transport failure, so the pull still runs', async () => {
    const client = await splitClient({
      sync_push: failure({ kind: 'store_busy', message: 'pool held', code: 'STORE_BUSY', retryable: true }),
    })

    const error: unknown = await client.engine.sync().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TEngineError)
    expect((error as TEngineError).code).toBe(EEngineErrorCode.STORE_BUSY)
    expect(client.syncCalls()).toEqual(['sync_push', 'sync_pull'])
  })

  test('when both halves fail the push failure is the one reported', async () => {
    const client = await splitClient({ sync_push: failure(PERMANENT), sync_pull: failure(RETRYABLE) })

    await expect(client.engine.sync()).rejects.toMatchObject({ message: 'duplicate key' })

    expect(client.syncCalls()).toEqual(['sync_push', 'sync_pull'])
  })

  test('a clean push with a failing pull reports the pull failure', async () => {
    const client = await splitClient({ sync_pull: failure(RETRYABLE) })

    await expect(client.engine.sync()).rejects.toMatchObject({ message: 'network down' })

    expect(client.syncCalls()).toEqual(SYNC_METHODS)
  })
})
