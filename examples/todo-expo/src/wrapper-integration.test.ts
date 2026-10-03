/// <reference types="bun" />
import { beforeEach, describe, expect, test } from 'bun:test'
import { createKizunaSync } from 'kizunasync'
import { createTempDatabase } from 'kizunasync/testing'
import { createRpcRemote } from 'kizunasync/supabase'
import { makeTodosConfig, makeUuid, type TServerRow } from './test-helpers'

/**
 * Wrapper-in-front-of-supabase integration test.
 *
 * The Expo demo's data path through the wrapper, with the wrapper in front of
 * supabase-js. Full documented client path: createKizunaSync over a temp-file
 * locator talking to createRpcRemote (the fenced kizunasync.pull/push remote
 * the demo ships), against a minimal in-memory fake supabase exposing only
 * .schema(name).rpc(fn, args), which records every RPC invocation.
 *
 * (a) works: an insert via kizunasync.from('todos').insert(), one kizunasync.sync(), and
 *     the row lands in the fake backend; a second kizunasync over a second store
 *     syncs and reads it back via kizunasync.from('todos').select().data.
 * (b) in front: the fake supabase is touched only by the adapter's pull/push
 *     RPCs. A local read (select().data) never touches it; offline reads hit
 *     the local store, never the network.
 *
 * Deterministic: injected uuid + now (mirrors sync-flow.test.ts). No expo /
 * react-native imports, so it runs headless under bun test.
 */
// MARK: - Wrapper-in-front-of-supabase integration test

const OWNER = 'user-1'
const TODOS = 'todos'

/**
 * Fake supabase-js, the EXACT surface createRpcRemote touches.
 *
 * .schema('kizunasync').rpc('pull', args) → { data: pull envelope, error: null }
 * .schema('kizunasync').rpc('push', args) → { data: { verdicts }, error: null }
 * Every call is recorded so the test can assert the wrapper-in-front contract.
 *
 * The backing store mirrors sync-flow.test.ts's server model (updated_at as the
 * cursor/seq, soft-delete tombstones, applied verdicts in request order) so the
 * second-device assertions exercise a real pull, not a stubbed empty page.
 */
// MARK: - Fake supabase-js

type TRpcCall = { fn: string; args: Record<string, unknown> }

type TWireMutation = {
  mutation_id: string
  op: string
  pk: string
  columns: Record<string, unknown>
}

/**
 * createRpcRemote arms a per-request deadline, so .rpc() must answer the same
 * awaitable-and-chainable builder supabase-js returns.
 */
const answering = (result: { data: unknown; error: unknown }) => {
  const settled = Promise.resolve(result)

  return {
    abortSignal: () => settled,
    then: settled.then.bind(settled),
  }
}

class FakeSupabase {
  rows = new Map<string, TServerRow>()
  calls: TRpcCall[] = []
  private tick = 0

  private nextStamp(): string {
    this.tick += 1

    return new Date(1_900_000_000_000 + this.tick * 1000).toISOString()
  }

  /** The client the adapter is handed: only .schema(...).rpc(...) is reachable. */
  clientFor(owner: string) {
    const self = this

    return {
      schema(_name: string) {
        return {
          rpc(fn: string, args: Record<string, unknown>) {
            self.calls.push({ fn, args })

            if (fn === 'pull') {
              return answering({ data: self.pullFrom(owner, args.cursor as string), error: null })
            }
            if (fn === 'push') {
              return answering({ data: self.applyBatch(owner, args.batch), error: null })
            }
            return answering({ data: null, error: { message: `unexpected rpc ${fn}` } })
          },
        }
      },
    }
  }

  /** `owner` stands in for the real server's RLS policy: it does the same visible-row filtering. */
  private pullFrom(owner: string, from: string) {
    const visible = [...this.rows.values()]
      .filter((row) => row.user_id === owner && row.updated_at > from)
      .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))
    let cursor = from
    const rows = []
    const tombstones = []

    for (const row of visible) {
      if (row.updated_at > cursor) {
        cursor = row.updated_at
      }
      if (row.deleted_at !== null) {
        tombstones.push({ deleted_at: row.deleted_at, pk: row.id, seq: row.updated_at, table: TODOS })
        continue
      }
      rows.push({
        pk: row.id,
        row: { id: row.id, user_id: row.user_id, title: row.title, done: row.done, image_path: row.image_path },
        seq: row.updated_at,
        table: TODOS,
      })
    }

    return { cursor, has_more: false, rows, signal: null, tombstones }
  }

  private applyBatch(owner: string, batch: unknown) {
    const { mutations } = batch as { mutations: TWireMutation[] }
    const verdicts = []

    for (const mutation of mutations) {
      if (mutation.op === 'delete') {
        const existing = this.rows.get(mutation.pk)

        if (existing !== undefined) {
          const stamp = this.nextStamp()

          this.rows.set(mutation.pk, { ...existing, deleted_at: stamp, updated_at: stamp })
        }
      } else {
        const existing = this.rows.get(mutation.pk)
        const merged: TServerRow = {
          id: mutation.pk,
          user_id: owner,
          title: '',
          done: false,
          image_path: null,
          deleted_at: null,
          updated_at: this.nextStamp(),
          ...existing,
        }

        if (typeof mutation.columns.title === 'string') {
          merged.title = mutation.columns.title
        }
        if (typeof mutation.columns.done === 'boolean') {
          merged.done = mutation.columns.done
        }
        if ('image_path' in mutation.columns) {
          merged.image_path = (mutation.columns.image_path as string | null) ?? null
        }
        merged.updated_at = this.nextStamp()
        this.rows.set(mutation.pk, merged)
      }
      verdicts.push({ mutation_id: mutation.mutation_id, verdict: 'applied' as const })
    }

    return { verdicts }
  }
}

// MARK: - Deterministic id minting

const makeKizunaSync = (backend: FakeSupabase, owner = OWNER) => {
  // The fake structurally satisfies the .schema().rpc() surface the adapter uses.
  const remote = createRpcRemote(backend.clientFor(owner) as never)

  return createKizunaSync(createTempDatabase().driver, remote, makeTodosConfig(), {
    schemaVersion: 1,
    uuid: makeUuid(),
    now: () => new Date(1_900_000_000_000).toISOString(),
  })
}

let backend: FakeSupabase

beforeEach(() => {
  backend = new FakeSupabase()
})

// MARK: - Tests

describe('the demo works through the wrapper in front of supabase', () => {
  test('an insert lands in supabase after one sync, and a second device reads it back', async () => {
    const deviceA = makeKizunaSync(backend)

    await deviceA.from(TODOS).insert({ id: 'todo-a', title: 'buy ink', done: false, image_path: null })

    // queued locally, nothing on the backend yet
    expect(await deviceA.getOutboxDepth()).toBe(1)
    expect(backend.rows.size).toBe(0)

    await deviceA.sync()

    // the row landed in the fake supabase backend, via the adapter's push RPC
    expect(await deviceA.getOutboxDepth()).toBe(0)
    expect(backend.rows.get('todo-a')?.title).toBe('buy ink')

    // a second device over a SECOND store pulls + reads it back
    const deviceB = makeKizunaSync(backend)

    await deviceB.sync()
    const titles = (await deviceB.from(TODOS).select()).data.map((row) => row.title)

    expect(titles).toEqual(['buy ink'])
  })

  test('the supabase stub is touched ONLY by the adapter (pull + push), never on a local read', async () => {
    const device = makeKizunaSync(backend)

    await device.from(TODOS).insert({ id: 'todo-a', title: 'offline first', done: false, image_path: null })
    await device.sync()

    const fns = backend.calls.map((call) => call.fn)

    expect(fns).toContain('push')
    expect(fns).toContain('pull')
    expect(backend.calls.every((call) => call.fn === 'pull' || call.fn === 'push')).toBe(true)

    // a LOCAL read must NOT touch supabase, offline reads never go to network
    const callsBeforeRead = backend.calls.length
    const local = (await device.from(TODOS).select()).data.map((row) => row.title)

    expect(local).toEqual(['offline first'])
    expect(backend.calls.length).toBe(callsBeforeRead)
  })

  test('an awaited update (toggle) applies locally at once and propagates on sync', async () => {
    const deviceA = makeKizunaSync(backend)

    await deviceA.from(TODOS).insert({ id: 'todo-a', title: 'toggle me', done: false, image_path: null })
    await deviceA.sync()

    // The update builder must be AWAITED to fire (supabase-js parity); this is exactly the path the shim's toggleTodo takes; a non-awaited write would silently never apply.
    await deviceA.from(TODOS).update({ done: true }).eq('id', 'todo-a')
    expect((await deviceA.from(TODOS).select().eq('id', 'todo-a')).data[0]?.done).toBe(true)
    await deviceA.sync()

    const deviceB = makeKizunaSync(backend)

    await deviceB.sync()
    expect((await deviceB.from(TODOS).select().eq('id', 'todo-a')).data[0]?.done).toBe(true)
  })

  test('a delete propagates as a tombstone and removes the row on a second device', async () => {
    const deviceA = makeKizunaSync(backend)

    await deviceA.from(TODOS).insert({ id: 'todo-a', title: 'delete me', done: false, image_path: null })
    await deviceA.sync()

    const deviceB = makeKizunaSync(backend)

    await deviceB.sync()
    expect((await deviceB.from(TODOS).select()).data).toHaveLength(1)

    await deviceA.from(TODOS).delete().eq('id', 'todo-a')
    await deviceA.sync()

    await deviceB.sync()
    expect((await deviceB.from(TODOS).select()).data).toHaveLength(0)
  })
})
