/// <reference types="bun" />
/**
 * The conflict scenario takes both panes offline for its staged writes. Any
 * step that throws inside that window must still hand both panes back online,
 * or the demo is left in a simulated airplane mode the visitor never chose.
 * Fake panes stand in for the two clients: only the offline switch, the local
 * writes, and sync are under test.
 */

import { describe, expect, mock, test } from 'bun:test'
import * as demoConfig from '../runtime/demo-config'
import * as scenarioRowId from './scenario-row-id'
import { createWireLog } from '../runtime/wire-log'
import type { IPaneClient } from '../runtime/kizunasync'
import type { TPaneId } from '../runtime/demo-config'

// Bun does not read the `@/` alias from tsconfig.app.json, so the two modules conflict.ts imports through it resolve to the real ones.
mock.module('@/runtime/demo-config', () => demoConfig)
mock.module('@/lib/scenario-row-id', () => scenarioRowId)

const { runConflictScenario } = await import('./conflict')

const VISITOR = '6f1b6a4e-0f9c-4a1e-9a4f-2c5d1e8b7a30'

/** Where a fake pane throws: its offline title write, or the first sync after it comes back online. */
type TFailure = 'offline-write' | 'reconnect-sync' | null

const makePane = (pane: TPaneId, failure: TFailure): IPaneClient => {
  let offline = false
  let wentOffline = false

  const sync = (): Promise<void> => {
    if (failure === 'reconnect-sync' && wentOffline && !offline) {
      return Promise.reject(new Error(`pane ${pane} could not reach the server`))
    }
    return Promise.resolve()
  }
  const from = () => ({
    select: () => ({ eq: () => Promise.resolve({ data: [{ id: 'row' }], error: null }) }),
    update: () => ({
      eq: () =>
        failure === 'offline-write' && offline
          ? Promise.reject(new Error(`pane ${pane} refused the local write`))
          : Promise.resolve({ data: [], error: null }),
    }),
  })

  return {
    pane,
    getOwnerId: () => VISITOR,
    isOffline: () => offline,
    setOffline: (value: boolean) => {
      offline = value
      wentOffline ||= value
    },
    sync,
    from,
  } as unknown as IPaneClient
}

const runWith = (paneA: IPaneClient, paneB: IPaneClient): Promise<void> =>
  runConflictScenario({ paneA, paneB, wireLog: createWireLog(), onStatus: () => undefined })

describe('runConflictScenario restores online', () => {
  test('both panes are back online after a clean run', async () => {
    const paneA = makePane('A', null)
    const paneB = makePane('B', null)

    await runWith(paneA, paneB)
    expect([paneA.isOffline(), paneB.isOffline()]).toEqual([false, false])
  })

  test('a local write that fails while both panes are offline still brings both back online', async () => {
    const paneA = makePane('A', null)
    const paneB = makePane('B', 'offline-write')

    await expect(runWith(paneA, paneB)).rejects.toThrow('pane B refused the local write')
    expect([paneA.isOffline(), paneB.isOffline()]).toEqual([false, false])
  })

  test('a sync that fails as pane A reconnects still brings pane B back online', async () => {
    const paneA = makePane('A', 'reconnect-sync')
    const paneB = makePane('B', null)

    await expect(runWith(paneA, paneB)).rejects.toThrow('pane A could not reach the server')
    expect([paneA.isOffline(), paneB.isOffline()]).toEqual([false, false])
  })
})
