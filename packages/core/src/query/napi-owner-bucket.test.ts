/// <reference types="bun" />
/**
 * A `byOwner` table never needs setBucket. The app client marks it
 * `bucket_owner` in the engine config, and the Rust engine fills its bucket
 * value with the store owner, the `sub` of the first token it sees, and keeps
 * that owner across a reopen. An insert that omits the owner column gets the
 * owner written into it before the optimistic row is stored. These run the
 * real addon, so they depend on the engine side of the owner bucket.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { byOwner, defineConfig } from '../config/config'
import { createKizunaSync, type IKizunaSync } from './kizunasync'
import { loadNapiAddon } from './napi-loader'
import { createTempDatabase } from '../testing/temp-database'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { IStoreLocator } from '../ports/store-locator'
import { EVerdictKind, type TPullRequest, type TPullResponse, type TPushRequest, type TPushResponse } from '../wire/types'

const hasAddon = loadNapiAddon() !== null

const config = defineConfig({
  tables: { items: { sync: 'read-write', bucket: byOwner('user_id') } },
})

const EMPTY_PULL: TPullResponse = { cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }

const applyAll = (request: TPushRequest): TPushResponse => ({
  verdicts: request.batch.mutations.map((mutation) => ({
    mutation_id: mutation.mutation_id,
    verdict: EVerdictKind.applied,
  })),
})

/** A remote that answers every pull empty, applies every push, and records the pull requests. */
const recordingRemote = (): IProtocolRemote & { pulls: TPullRequest[] } => {
  const pulls: TPullRequest[] = []

  return {
    pulls,
    pull: async (request) => {
      pulls.push(request)

      return EMPTY_PULL
    },
    push: async (request) => applyAll(request),
  }
}

/** An unsigned compact JWS whose payload carries `sub`: the engine decodes the subject and never verifies it. */
const tokenFor = (subject: string): string =>
  ['e30', Buffer.from(JSON.stringify({ sub: subject })).toString('base64url'), 'signature'].join('.')

describe.skipIf(!hasAddon)('the owner bucket on the Rust engine', () => {
  const open: Array<() => void> = []

  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.()
    }
  })

  const start = (remote: IProtocolRemote, driver: IStoreLocator = createTempDatabase().driver): IKizunaSync => {
    const kizunasync = createKizunaSync(driver, remote, config, { pollIntervalMs: 0, inspector: false })

    open.push(() => kizunasync.dispose())

    return kizunasync
  }

  test('the first token fills the owner bucket, so a pull needs no setBucket', async () => {
    const remote = recordingRemote()
    const kizunasync = start(remote)

    await kizunasync.setRemoteAccessToken(tokenFor('user-a'))
    await kizunasync.pullOnce()

    expect(remote.pulls[0]?.buckets).toEqual([{ table: 'items', params: { user_id: 'user-a' } }])
  })

  test('a reopened store pulls under its owner before any token arrives', async () => {
    const database = createTempDatabase()
    const first = start(recordingRemote(), database.driver)

    await first.setRemoteAccessToken(tokenFor('user-a'))
    await first.pullOnce()
    first.dispose()

    const remote = recordingRemote()
    const reopened = start(remote, database.driver)

    open.push(() => {
      database.remove()
    })
    await reopened.pullOnce()

    expect(remote.pulls[0]?.buckets).toEqual([{ table: 'items', params: { user_id: 'user-a' } }])
  })

  test('an insert that omits the owner column reads back with the owner filled in', async () => {
    const kizunasync = start(recordingRemote())

    await kizunasync.setRemoteAccessToken(tokenFor('user-a'))
    await kizunasync.from('items').insert({ id: '00000000-0000-4000-8000-00000000000a', title: 'works on a plane' })

    const { data } = await kizunasync.from('items').select('id, user_id')

    expect(data).toEqual([{ id: '00000000-0000-4000-8000-00000000000a', user_id: 'user-a' }])
  })
})
