/// <reference types="bun" />
/**
 * Example round-trip test (app client + in-memory PostgREST backend).
 *
 * End-to-end wiring of the todo board without vue, supabase-js, or the
 * browser worker: the documented client (`createKizunaSync`) on the Rust engine
 * over bun:sqlite, talking to a Map-backed IProtocolRemote that mimics a
 * PostgREST-shaped backend (public.todos: updated_at cursor, soft-delete
 * tombstones, applied-only verdicts in request order). kizunasync.ts imports the
 * browser worker driver and cannot load here; this test reconstructs its
 * config and mutation shapes and runs the same path the browser does.
 *
 * A missing N-API addon fails this suite. `createKizunaSync` has no engine to fall
 * back to; it throws, and does not report a pass on another implementation.
 * Build the addon with `bun run cargo:napi` from the repository root.
 */
// MARK: - Example round-trip test

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createKizunaSync, type IKizunaSync, type IProtocolRemote } from 'kizunasync'
import { createTempDatabase } from 'kizunasync/testing'
import { makeUuid, makeTodosConfig, type TServerRow } from './test-helpers'

const OWNER = 'user-1'
const CREATED_AT = new Date(0).toISOString()

// MARK: - In-memory backend shared by every device against one "server"

class FakeBackend {
  rows = new Map<string, TServerRow>()
  private tick = 0

  private nextStamp(): string {
    this.tick += 1

    return new Date(1_900_000_000_000 + this.tick * 1000).toISOString()
  }

  remoteFor(owner: string): IProtocolRemote {
    return {
      pull: (request) => {
        const out = [...this.rows.values()]
          .filter((row) => row.user_id === owner && row.updated_at > request.cursor)
          .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))
        let cursor = request.cursor
        const rows = []
        const tombstones = []

        for (const row of out) {
          if (row.updated_at > cursor) {
            cursor = row.updated_at
          }
          if (row.deleted_at !== null) {
            tombstones.push({
              deleted_at: row.deleted_at,
              pk: row.id,
              seq: row.updated_at,
              table: 'todos',
            })
            continue
          }
          rows.push({
            pk: row.id,
            row: {
              id: row.id,
              user_id: row.user_id,
              title: row.title,
              done: row.done,
              image_path: row.image_path,
              created_at: row.created_at,
            },
            seq: row.updated_at,
            table: 'todos',
          })
        }
        return Promise.resolve({ cursor, has_more: false, rows, signal: null, tombstones })
      },
      push: (request) => {
        const verdicts = []

        for (const mutation of request.batch.mutations) {
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
              created_at: this.nextStamp(),
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
            if (typeof mutation.columns.created_at === 'string') {
              merged.created_at = mutation.columns.created_at
            }
            merged.updated_at = this.nextStamp()
            this.rows.set(mutation.pk, merged)
          }
          verdicts.push({ mutation_id: mutation.mutation_id, verdict: 'applied' as const })
        }
        return Promise.resolve({ verdicts })
      },
    }
  }
}

// MARK: - Deterministic id minting

let backend: FakeBackend
const open: IKizunaSync[] = []

/**
 * One device. `pollIntervalMs: 0` keeps the app client's 15 s scheduler out of a
 * test that drives every sync itself; afterEach releases what each one holds.
 */
const makeDevice = (owner = OWNER): IKizunaSync => {
  const device = createKizunaSync(createTempDatabase().driver, backend.remoteFor(owner), makeTodosConfig(), {
    uuid: makeUuid(),
    now: () => new Date(1_900_000_000_000).toISOString(),
    pollIntervalMs: 0,
  })

  open.push(device)

  return device
}

const titlesOn = async (device: IKizunaSync): Promise<string[]> =>
  (await device.from('todos').select()).data.map((row) => String(row.title))

beforeEach(() => {
  backend = new FakeBackend()
})

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.dispose()
  }
})

// MARK: - Tests

describe('the engine under the example', () => {
  test('the suite runs on the Rust engine, never a silent TypeScript fallback', () => {
    expect(makeDevice().engine).toBe('rust')
  })
})

describe('offline → online round trip', () => {
  test('an offline add queues, then lands on the server after one sync', async () => {
    const device = makeDevice()

    await device
      .from('todos')
      .insert({ id: 'todo-a', title: 'buy ink', done: false, image_path: null, created_at: CREATED_AT })
    expect(await device.getOutboxDepth()).toBe(1)
    expect(backend.rows.size).toBe(0)

    await device.sync()

    expect(await device.getOutboxDepth()).toBe(0)
    expect(backend.rows.get('todo-a')?.title).toBe('buy ink')
  })

  test('a second device pulls the first device\'s row', async () => {
    const deviceA = makeDevice()

    await deviceA
      .from('todos')
      .insert({ id: 'todo-a', title: 'from A', done: false, image_path: null, created_at: CREATED_AT })
    await deviceA.sync()

    const deviceB = makeDevice()

    await deviceB.sync()

    expect(await titlesOn(deviceB)).toEqual(['from A'])
  })
})

describe('mutations propagate', () => {
  test('a toggle propagates to a second device', async () => {
    const deviceA = makeDevice()

    await deviceA
      .from('todos')
      .insert({ id: 'todo-a', title: 'toggle me', done: false, image_path: null, created_at: CREATED_AT })
    await deviceA.sync()
    await deviceA.from('todos').update({ done: true }).eq('id', 'todo-a')
    await deviceA.sync()

    const deviceB = makeDevice()

    await deviceB.sync()

    expect((await deviceB.from('todos').select().eq('id', 'todo-a')).data[0]?.done).toBe(true)
  })

  test('a delete propagates as a tombstone and removes the row downstream', async () => {
    const deviceA = makeDevice()

    await deviceA
      .from('todos')
      .insert({ id: 'todo-a', title: 'delete me', done: false, image_path: null, created_at: CREATED_AT })
    await deviceA.sync()

    const deviceB = makeDevice()

    await deviceB.sync()
    expect((await deviceB.from('todos').select()).data).toHaveLength(1)

    await deviceA.from('todos').delete().eq('id', 'todo-a')
    await deviceA.sync()

    await deviceB.sync()
    expect((await deviceB.from('todos').select()).data).toHaveLength(0)
  })
})

describe('idempotency', () => {
  test('a second sync with no new work is a no-op', async () => {
    const device = makeDevice()

    await device
      .from('todos')
      .insert({ id: 'todo-a', title: 'once', done: false, image_path: null, created_at: CREATED_AT })
    await device.sync()
    const cursorAfterFirst = (await device.getCheckpoint()).cursor
    const rowCountAfterFirst = backend.rows.size

    await device.sync()

    expect(await device.getOutboxDepth()).toBe(0)
    expect(backend.rows.size).toBe(rowCountAfterFirst)
    expect((await device.from('todos').select()).data).toHaveLength(1)
    expect((await device.getCheckpoint()).cursor >= cursorAfterFirst).toBe(true)
  })

  test('two devices on different owners stay isolated', async () => {
    const deviceA = makeDevice('user-1')

    await deviceA
      .from('todos')
      .insert({ id: 'todo-a', title: 'alice only', done: false, image_path: null, created_at: CREATED_AT })
    await deviceA.sync()

    const deviceB = makeDevice('user-2')

    await deviceB.sync()

    expect((await deviceB.from('todos').select()).data).toHaveLength(0)
  })
})
