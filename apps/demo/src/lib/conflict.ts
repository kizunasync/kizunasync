import { EWireEntryKind } from '@kizunasync/core'
import { CONFLICT_TITLE_PREFIX, EScenarioRole, SOFT_DELETE_TITLE, TODOS_TABLE, type TScenarioRole } from '@/runtime/demo-config'
import type { IPaneClient } from '@/runtime/kizunasync'
import type { IWireLog } from '@/runtime/wire-log'
import { ARCHIVED_COLUMN, formatClockTime } from '@kizunasync/utilities'
import { deriveScenarioRowId } from '@/lib/scenario-row-id'

// MARK: - Simulate conflict

/**
 * Both panes write a different value to the same column of the same row while
 * both are offline, then reconnect one after the other. The server's default
 * conflict mode for this table is `arrival`, so the merge is decided by the
 * order the writes reach the server, not by the order they were made and not
 * by any client clock. The pane that arrives second wins the contested
 * column.
 *
 * The sequence is staged, not raced, so the viewer shows the outcome the copy
 * predicts. Pane A is released first; pane B arrives second and therefore
 * wins.
 */
export interface IRunConflictParams {
  paneA: IPaneClient
  paneB: IPaneClient
  wireLog: IWireLog
  onStatus: (message: string) => void
}

/** The pane released second, and therefore the expected winner under `arrival`. */
export const CONFLICT_WINNER = 'B'

export async function runConflictScenario(params: IRunConflictParams): Promise<void> {
  const { paneA, paneB, wireLog, onStatus } = params
  const stamp = formatClockTime(Date.now())
  const rowId = await scenarioRowId(paneA, EScenarioRole.conflict)

  onStatus('Staging the contested row on both panes…')
  wireLog.record('A', { kind: EWireEntryKind.note, text: 'conflict: staging the contested row' })
  await ensureRow(paneA, rowId, `${CONFLICT_TITLE_PREFIX} nobody has written to it yet`)
  await paneA.sync()
  await paneB.sync()

  onStatus('Both panes offline, writing a different title to each.')
  paneA.setOffline(true)
  paneB.setOffline(true)

  // A step that throws inside the offline window must not leave either pane in an airplane mode the visitor never chose.
  try {
    await paneA
      .from(TODOS_TABLE)
      .update({ title: `${CONFLICT_TITLE_PREFIX} pane A wrote at ${stamp}` })
      .eq('id', rowId)
    await paneB
      .from(TODOS_TABLE)
      .update({ title: `${CONFLICT_TITLE_PREFIX} pane B wrote at ${stamp}` })
      .eq('id', rowId)
    wireLog.record('A', {
      kind: EWireEntryKind.note,
      text: 'conflict: both panes hold a queued write for the same column',
    })

    onStatus('Reconnecting pane A first…')
    paneA.setOffline(false)
    await paneA.sync()

    onStatus('Reconnecting pane B, it arrives second.')
    paneB.setOffline(false)
    await paneB.sync()
  } finally {
    paneA.setOffline(false)
    paneB.setOffline(false)
  }

  // Pane A only learns it lost the column on its next pull; without this the two panes would sit visibly disagreeing until the doorbell happened to fire.
  await paneA.sync()
  wireLog.record('B', { kind: EWireEntryKind.note, text: 'conflict: pane B arrived second and won the title column' })
  onStatus('Pane B arrived second, so its title won. Both panes now agree.')
}

// MARK: - Simulate edit + soft delete

/**
 * Counterpart to the conflict scenario. Both panes go offline; pane A ticks
 * the item done, pane B soft-deletes the SAME item. These are DIFFERENT
 * columns, so there is nothing to arbitrate: column-LWW merges per column,
 * and both writes survive. The item comes back checked AND archived. A
 * whole-row last-write-wins store would have one write clobber the other.
 *
 * Pane B reconnects first here, so the surviving `done` value cannot be
 * explained as "whoever arrived last won the row".
 */
export async function runEditAndSoftDeleteScenario(params: IRunConflictParams): Promise<void> {
  const { paneA, paneB, wireLog, onStatus } = params
  const rowId = await scenarioRowId(paneA, EScenarioRole.softDelete)

  onStatus('Staging the shared row on both panes…')
  wireLog.record('A', { kind: EWireEntryKind.note, text: 'edit+archive: staging the shared row' })
  await ensureRow(paneA, rowId, SOFT_DELETE_TITLE)
  await paneA.sync()
  await paneB.sync()

  // A prior run leaves the row archived and ticked; clear both so the scenario starts from a state where the result is unambiguous.
  await paneA
    .from(TODOS_TABLE)
    .update({ done: false, [ARCHIVED_COLUMN]: null })
    .eq('id', rowId)
  await paneA.sync()
  await paneB.sync()

  onStatus('Both panes offline. A ticks it done, B soft-deletes it.')
  paneA.setOffline(true)
  paneB.setOffline(true)
  await paneA.from(TODOS_TABLE).update({ done: true }).eq('id', rowId)
  await paneB
    .from(TODOS_TABLE)
    .update({ [ARCHIVED_COLUMN]: new Date().toISOString() })
    .eq('id', rowId)
  wireLog.record('B', { kind: EWireEntryKind.note, text: 'edit+archive: A holds done=true, B holds archived_at' })

  onStatus('Reconnecting pane B first…')
  paneB.setOffline(false)
  await paneB.sync()

  onStatus('Reconnecting pane A, it arrives second.')
  paneA.setOffline(false)
  await paneA.sync()
  await paneB.sync()

  wireLog.record('A', { kind: EWireEntryKind.note, text: 'edit+archive: both columns survived: checked AND archived' })
  onStatus('Different columns, so nothing was contested: the item is checked AND archived on both panes.')
}

// MARK: - internal

/**
 * This visitor's pk for a scenario. Both panes share one uid, so both derive the
 * same id and the race still contests a single row.
 */
async function scenarioRowId(pane: IPaneClient, role: TScenarioRole): Promise<string> {
  const ownerId = pane.getOwnerId()

  if (ownerId === null) {
    throw new Error(`pane ${pane.pane} is not signed in yet`)
  }
  return deriveScenarioRowId(ownerId, role)
}

/**
 * Insert the contested row if this pane has never seen it. The derived pk keeps
 * the button repeatable; the local insert would throw LOCAL_CONSTRAINT on a
 * second run, so the existence check is the guard rather than a swallowed error.
 * user_id is stamped explicitly because the fixture's INSERT policy checks it
 * against the caller's uid.
 */
async function ensureRow(pane: IPaneClient, id: string, title: string): Promise<void> {
  const existing = await pane.from(TODOS_TABLE).select().eq('id', id)

  if (existing.data.length > 0) {
    return
  }
  const ownerId = pane.getOwnerId()

  if (ownerId === null) {
    throw new Error(`pane ${pane.pane} is not signed in yet`)
  }
  await pane.from(TODOS_TABLE).insert({
    id,
    user_id: ownerId,
    title,
    done: false,
    created_at: new Date().toISOString(),
  })
}
