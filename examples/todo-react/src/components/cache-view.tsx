import { useEffect, useState } from 'react'
import type { IInspectorSnapshot, IInspectorVerdict } from '@kizunasync/core'
import { useKizunaSync } from '@kizunasync/react'
import type { IQueryLogEntry, TEngineEventLogEntry } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../kizunasync'
import { Brand } from './brand-header'
import { DetailModal, type TDialogContent } from './cache-view/detail-modal'
import { EngineEvents } from './cache-view/engine-events'
import { OperationsLog } from './cache-view/operations-log'
import { QueuedMutations } from './cache-view/queued-mutations'
import { StatsRow } from './cache-view/stats-row'
import { Verdicts } from './cache-view/verdicts'

// MARK: - Cache view

/**
 * The inspector is the engine's `inspect()` snapshot, read in the browser
 * worker: outbox depth/contents, the durable cursor, the last applied mutation
 * id, and a bounded ring of rejected/aborted verdicts. It is live: subscribe()
 * fires on every engine event, so we re-read the snapshot and verdicts on each
 * notification. The query log is the examples-devtools ring (createQueryLog),
 * carrying the reads and writes the board records; the read/write test buttons
 * live on the TODO screen. A null inspector means devtools are off (the
 * production default); here the shim enables them. Each section below is its
 * own render-region component in ./cache-view/.
 */
export function CacheView() {
  // MARK: - Variables
  const client = useKizunaSync() as IKizunaSyncShim
  const inspector = client.inspector ?? null
  const queryLog = client.queryLog
  const [snapshot, setSnapshot] = useState<IInspectorSnapshot | null>(null)
  const [verdicts, setVerdicts] = useState<IInspectorVerdict[]>([])
  const [log, setLog] = useState<readonly IQueryLogEntry[]>(queryLog.entries())
  const [dialog, setDialog] = useState<TDialogContent | null>(null)
  const [engineEvents, setEngineEvents] = useState<readonly TEngineEventLogEntry[]>(client.getEngineEvents())

  // MARK: - Lifecycle

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

  useEffect(() => {
    setLog(queryLog.entries())

    return queryLog.subscribe(() => setLog(queryLog.entries()))
  }, [queryLog])

  useEffect(() => {
    setEngineEvents(client.getEngineEvents())

    return client.subscribeEngineEvents(() => setEngineEvents(client.getEngineEvents()))
  }, [client])

  // MARK: - render

  if (inspector === null) {
    return (
      <div className="column">
        <Brand sub="debug" />
        <p className="cache-disabled">inspector disabled</p>
      </div>
    )
  }

  return (
    <div className="column">
      <Brand sub="debug" />

      <StatsRow snapshot={snapshot} onOpenDialog={setDialog} />

      <hr className="cache-rule" />

      <QueuedMutations snapshot={snapshot} onOpenDialog={setDialog} />

      <hr className="cache-rule" />

      <OperationsLog log={log} onOpenDialog={setDialog} />

      <hr className="cache-rule" />

      <Verdicts verdicts={verdicts} onOpenDialog={setDialog} />

      <hr className="cache-rule" />

      <EngineEvents engineEvents={engineEvents} />

      {dialog !== null ? <DetailModal content={dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}
