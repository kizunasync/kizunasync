import { useEffect, useRef } from 'react'
import type { IKizunaSync } from 'kizunasync'
import { IDENTITY_RECOVERED_MESSAGE, messageOf, resetOnIdentityChange } from '@kizunasync/utilities'

/**
 * Rebuilds the local database when it belongs to a previous session (the
 * anonymous user it was synced for is gone and recovery signed in a new one),
 * through the shared resetOnIdentityChange. Queued writes keep the reset
 * banner up instead, so the user decides whether to drop them. Gated on
 * `ready` like the boot recovery: before it, the client may be the booting
 * placeholder.
 */
export function useIdentityRecovery({
  ready,
  client,
  runSync,
  onMessage,
}: {
  ready: boolean
  client: IKizunaSync
  runSync: () => Promise<void>
  onMessage: (message: string) => void
}): void {
  // Latest callbacks without re-subscribing: a new watch starts with no recovery in flight and re-checks the health, so re-subscribing on a re-render during a recovery would start a second reset.
  const runSyncRef = useRef(runSync)
  const onMessageRef = useRef(onMessage)

  runSyncRef.current = runSync
  onMessageRef.current = onMessage

  useEffect(() => {
    if (!ready) {
      return
    }
    return resetOnIdentityChange({
      client,
      reset: () => client.reset(),
      sync: () => runSyncRef.current(),
      keepQueuedWrites: true,
      onRecovered: () => {
        onMessageRef.current(IDENTITY_RECOVERED_MESSAGE)
      },
      onFailed: (cause) => {
        onMessageRef.current(messageOf(cause))
      },
    })
  }, [ready, client])
}
