/**
 * Live outbox depth for the sync bar: starts from useSyncStatus's own value,
 * then a QUEUE_DEPTH engine event overrides it with the real payload field
 * the moment a local write queues.
 */

import { useEffect, useState } from 'react'
import { EEngineEventType } from '@kizunasync/core'
import type { IKizunaSyncShim } from '../../kizunasync'

export function usePendingWrites(client: IKizunaSyncShim, outboxDepth: number): number {
  const [pendingWrites, setPendingWrites] = useState(outboxDepth)

  useEffect(() => {
    setPendingWrites(outboxDepth)
  }, [outboxDepth])

  // The engine emits QUEUE_DEPTH after every local write.
  useEffect(() => {
    return client.on((event) => {
      if (event.type === EEngineEventType.QUEUE_DEPTH) {
        setPendingWrites(event.depth)
      }
    })
  }, [client])

  return pendingWrites
}
