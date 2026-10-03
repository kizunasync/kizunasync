import { useEffect, useState, useSyncExternalStore } from 'react'
import { useKizunaSync } from '@kizunasync/react'
import type { IInspectorSnapshot, IInspectorVerdict } from '@kizunasync/core'
import type { IQueryLogEntry } from '@kizunasync/utilities'
import { getQueryLog } from '../kizunasync-shim'
import { getEngineEvents, subscribeEngineEvents, type TEngineEventLogEntry } from '../engine-events'
import { compareCreated, LOG_RENDER_CAP } from '../lib/cache-inspector'

/**
 * The Cache screen's live data. The inspector
 * is the engine's own inspect() snapshot (outbox depth/contents, the durable
 * cursor, the last applied mutation id) plus a bounded ring of
 * rejected/aborted verdicts: `subscribe()` fires on every engine event, so
 * the snapshot and verdicts are re-read then. `depth`/`cursor`/`lastMutationId`
 * default once here instead of at every read site: `lastMutationId` can be
 * null even with a live snapshot, so its default is not merely "no snapshot
 * yet" (@CONVENTIONS.md). A null inspector means devtools off (production
 * default).
 */
export interface ICacheInspectorState {
  isEnabled: boolean
  depth: number
  cursor: string
  lastMutationId: string
  queued: IInspectorSnapshot['queued']
  verdicts: IInspectorVerdict[]
  visibleLog: readonly IQueryLogEntry[]
  engineEvents: readonly TEngineEventLogEntry[]
}

export function useCacheInspector(): ICacheInspectorState {
  const client = useKizunaSync()
  const inspector = client.inspector ?? null
  const [snapshot, setSnapshot] = useState<IInspectorSnapshot | null>(null)
  const [verdicts, setVerdicts] = useState<IInspectorVerdict[]>([])
  const [logEntries, setLogEntries] = useState<readonly IQueryLogEntry[]>([])
  const engineEvents = useSyncExternalStore(subscribeEngineEvents, getEngineEvents, getEngineEvents)

  useEffect(() => {
    const log = getQueryLog()

    setLogEntries(log.entries())

    return log.subscribe(() => {
      setLogEntries(log.entries())
    })
  }, [])

  useEffect(() => {
    if (inspector === null) {
      setSnapshot(null)
      setVerdicts([])

      return
    }
    let active = true
    const read = (): void => {
      void inspector.snapshot().then((next) => {
        if (active) {
          setSnapshot(next)
        }
      })

      if (active) {
        setVerdicts(inspector.verdicts())
      }
    }
    read()
    const unsubscribe = inspector.subscribe(read)

    return () => {
      active = false
      unsubscribe()
    }
  }, [inspector])

  const queued =
    snapshot === null ? [] : snapshot.queued.slice().sort((left, right) => compareCreated(left.createdAt, right.createdAt))

  return {
    isEnabled: inspector !== null,
    depth: snapshot?.depth ?? 0,
    cursor: snapshot?.cursor ?? 'n/a',
    lastMutationId: snapshot?.lastMutationId ?? 'n/a',
    queued,
    verdicts,
    visibleLog: logEntries.slice(-LOG_RENDER_CAP).reverse(),
    engineEvents,
  }
}
