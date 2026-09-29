import { EEngineEventType, type TEngineEvent } from '../wire/types'

/**
 * The events that can change what a row read would return: a committed local
 * write or a committed pull (LOCAL_CHANGED), and the two lifecycle signals
 * (RESET_REQUIRED, CHECKPOINT_EXPIRED) that gate or rehydrate the local
 * snapshot (@../../../../docs/sync/protocol-overview.md). Every other event
 * either carries no row change of its own (QUEUE_DEPTH, a verdict) or rides a
 * LOCAL_CHANGED from the same commit (COLUMN_OVERWRITTEN), so it needs no read
 * of its own.
 */
export function reReadsRows(event: TEngineEvent): boolean {
  return (
    event.type === EEngineEventType.LOCAL_CHANGED ||
    event.type === EEngineEventType.RESET_REQUIRED ||
    event.type === EEngineEventType.CHECKPOINT_EXPIRED
  )
}
