/**
 * The edge-case lab every example wires beside its kizunasync client: reset local
 * (wipe store + outbox + attachment sandbox + the devtools rings), expire
 * checkpoint (rewind the durable cursor), and force a server conflict. Built
 * once at client construction, the same way each example already builds its
 * live-sync gate and query log, rather than re-wired on every button press.
 */

import type { IKizunaSync } from 'kizunasync'
import { forceServerConflict as forceServerConflictOnServer, type IConflictDrillRemote } from './conflict-drills'
import type { IQueryLog } from './query-log'

// MARK: - Types

export interface IWireLabControlsOptions {
  client: Pick<IKizunaSync, 'reset' | 'seedCheckpoint' | 'from' | 'inspector'>
  queryLog: IQueryLog
  remote: IConflictDrillRemote
  table: string
}

export interface ILabControls {
  /**
   * Atomic local wipe: store + outbox + attachment sandbox (client.reset()),
   * then the devtools rings last so the reset's own SQL is wiped too.
   */
  resetLocal: () => Promise<void>

  /**
   * Rewind the durable cursor so the next pull re-walks history: the lab's
   * local approximation of the server's typed CHECKPOINT_EXPIRED signal.
   */
  expireCheckpoint: () => Promise<void>

  /**
   * Write a conflicting edit directly to the server (bypassing the client) so
   * a later local edit plus sync demonstrates last-write-wins.
   */
  forceServerConflict: () => Promise<string>
}

// MARK: - wireLabControls

export function wireLabControls(options: IWireLabControlsOptions): ILabControls {
  const { client, queryLog, remote, table } = options

  return {
    resetLocal: async () => {
      await client.reset()
      queryLog.clear()
      client.inspector?.clear()
    },
    expireCheckpoint: () => client.seedCheckpoint('0'),
    forceServerConflict: () => forceServerConflictOnServer(remote, client, table),
  }
}
