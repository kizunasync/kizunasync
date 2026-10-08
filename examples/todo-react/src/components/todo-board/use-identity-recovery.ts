/**
 * Rebuilds the local database when it belongs to a previous session (the
 * anonymous user it was synced for is gone and recovery signed in a new one),
 * through the shared resetOnIdentityChange. Queued writes keep the reset
 * banner up instead, so the user decides whether to drop them.
 */

import { useEffect, useRef } from 'react'
import { IDENTITY_RECOVERED_MESSAGE, messageOf, resetOnIdentityChange } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../../kizunasync'

export interface IUseIdentityRecoveryParams {
  client: IKizunaSyncShim
  syncNow: () => Promise<void>
  onMessage: (message: string) => void
}

export function useIdentityRecovery({ client, syncNow, onMessage }: IUseIdentityRecoveryParams): void {
  // Latest callbacks without re-subscribing: a new watch starts with no recovery in flight and re-checks the health, so re-subscribing on a re-render during a recovery would start a second reset.
  const syncNowRef = useRef(syncNow)
  const onMessageRef = useRef(onMessage)

  syncNowRef.current = syncNow
  onMessageRef.current = onMessage

  useEffect(
    () =>
      resetOnIdentityChange({
        client,
        reset: () => client.reset(),
        sync: () => syncNowRef.current(),
        keepQueuedWrites: true,
        onRecovered: () => {
          onMessageRef.current(IDENTITY_RECOVERED_MESSAGE)
        },
        onFailed: (cause) => {
          onMessageRef.current(messageOf(cause))
        },
      }),
    [client],
  )
}
