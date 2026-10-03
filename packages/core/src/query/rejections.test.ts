// MARK: - Rejection journal on the app client

/**
 * The app-facing half of the durable journal: what the engine wrote at reconcile
 * time must be readable, and dismissable, through the kizunasync surface, long after
 * the MUTATION_REJECTED event fired and its subscriber is gone.
 */

import { describe, expect, test } from 'bun:test'
import { createKizunaSync } from './kizunasync'
import { byOwner, defineConfig } from '../config/config'
import { ERejectReason, ERejectionKind, EVerdictKind } from '../wire/types'
import { createTempDatabase } from '../testing/temp-database'
import type { IProtocolRemote } from '../ports/protocol-remote'

type TDb = {
  public: {
    Tables: {
      items: {
        Row: { id: string; title: string; done: boolean; user_id: string }
      }
    }
  }
}

const testConfig = () =>
  defineConfig<TDb>({
    tables: {
      items: { sync: 'read-write', bucket: byOwner('user_id') },
    },
  })

/** Every mutation comes back rejected: RLS denial, so no authoritative row. */
const rejectAllRemote = (): IProtocolRemote => ({
  pull: () =>
    Promise.resolve({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: (request) =>
    Promise.resolve({
      verdicts: request.batch.mutations.map((mutation) => ({
        mutation_id: mutation.mutation_id,
        verdict: EVerdictKind.rejected,
        reason: ERejectReason.RLS_DENIED,
        server_row: null,
      })),
    }),
})

const makeKizunaSync = () =>
  createKizunaSync(createTempDatabase().driver, rejectAllRemote(), testConfig(), {
    uuid: () => '00000000-0000-4000-8000-000000000001',
    now: () => new Date(1_900_000_000_000).toISOString(),
  })

describe('kizunasync.rejections()', () => {
  test('a rejected write is readable after the event, then dismissable', async () => {
    const kizunasync = makeKizunaSync()

    await kizunasync.from('items').insert({ id: 'p1', title: 'x', done: false, user_id: 'u' })
    await kizunasync.pushOnce()

    const rejections = await kizunasync.rejections()

    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toMatchObject({
      table: 'items',
      pk: 'p1',
      kind: ERejectionKind.REJECTED,
      reason: ERejectReason.RLS_DENIED,
      serverRow: null,
      dismissed: false,
    })

    await kizunasync.dismissRejection(rejections[0]!.mutationId)

    expect(await kizunasync.rejections()).toEqual([])
    expect(await kizunasync.rejections({ includeDismissed: true })).toHaveLength(1)
    kizunasync.dispose()
  })
})
