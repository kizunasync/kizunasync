/**
 * Live outbox depth for the sync bar: starts from useSyncStatus's own value,
 * then a live QUEUE_DEPTH event (when the engine emits one) overrides it with
 * the real payload field.
 */

import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { EEngineEventType } from '@kizunasync/core'
import type { IKizunaSyncShim } from '../kizunasync'

export function usePendingWrites(client: IKizunaSyncShim, outboxDepth: Ref<number>): Ref<number> {
  const queueDepth = ref(outboxDepth.value)

  watch(outboxDepth, (next) => {
    queueDepth.value = next
  })

  const unsubscribeEngineSignals = client.on((event) => {
    if (event.type === EEngineEventType.QUEUE_DEPTH) {
      queueDepth.value = event.depth
    }
  })

  onScopeDispose(unsubscribeEngineSignals)

  return queueDepth
}
