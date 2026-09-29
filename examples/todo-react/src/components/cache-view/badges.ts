import { EEngineEventType, type TEngineEvent } from '@kizunasync/core'
import type { TQueryOp } from '@kizunasync/utilities'

// MARK: - Traffic-light op palette

export const OP_BADGE_CLASS: Record<TQueryOp, string> = {
  SELECT: 'op-badge is-select',
  INSERT: 'op-badge is-insert',
  UPDATE: 'op-badge is-update',
  DELETE: 'op-badge is-delete',
  PRAGMA: 'op-badge is-neutral',
  TX: 'op-badge is-neutral',
  OTHER: 'op-badge is-neutral',
}

// MARK: - Queued-mutation op palette

export const QUEUE_BADGE_CLASS: Record<string, string> = {
  insert: 'op-badge is-insert',
  update: 'op-badge is-update',
  delete: 'op-badge is-delete',
}

// MARK: - Engine-event badge palette

export const ENGINE_EVENT_BADGE_CLASS: Record<TEngineEvent['type'], string> = {
  [EEngineEventType.LOCAL_CHANGED]: 'op-badge is-neutral',
  [EEngineEventType.MUTATION_REJECTED]: 'op-badge is-delete',
  [EEngineEventType.BATCH_ABORTED]: 'op-badge is-delete',
  [EEngineEventType.CHECKPOINT_EXPIRED]: 'op-badge is-update',
  [EEngineEventType.RESET_REQUIRED]: 'op-badge is-delete',
  [EEngineEventType.DEAD_LETTER]: 'op-badge is-delete',
  [EEngineEventType.QUEUE_DEPTH]: 'op-badge is-select',
  [EEngineEventType.COLUMN_OVERWRITTEN]: 'op-badge is-update',
}

// MARK: - Key handler factory

export function onActivate(cb: () => void): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      cb()
    }
  }
}
