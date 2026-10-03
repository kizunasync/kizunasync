import { createEngineEventLog, type TEngineEventLogEntry } from '@kizunasync/utilities'

/**
 * Client-side ring of the engine's side-channel events, the raw feed behind
 * the Cache tab's "Engine events" section. Shared with the other example apps
 * through @kizunasync/utilities.
 *
 * The engine emits events fire-and-forget: nothing durable records that a
 * LOCAL_CHANGED or a QUEUE_DEPTH ever happened. A screen that mounts late
 * sees nothing. The app shell subscribes once at boot (where the verdict
 * toasts already subscribe) and every event lands here, newest last. In
 * memory only: a reload starts an empty ring, same as the query log.
 */
// MARK: - Engine-event ring

const engineEventLog = createEngineEventLog()

export const recordEngineEvent = engineEventLog.record
export const getEngineEvents = engineEventLog.entries
export const subscribeEngineEvents = engineEventLog.subscribe

export type { TEngineEventLogEntry }
