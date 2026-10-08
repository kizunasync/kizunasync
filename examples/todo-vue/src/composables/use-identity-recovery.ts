/**
 * Rebuilds the local database when it belongs to a previous session (the
 * anonymous user it was synced for is gone and recovery signed in a new one),
 * through the shared resetOnIdentityChange. Queued writes keep the reset
 * banner up instead, so the user decides whether to drop them. The watch ends
 * with the calling component's scope.
 */

import { onScopeDispose } from 'vue'
import { IDENTITY_RECOVERED_MESSAGE, messageOf, resetOnIdentityChange } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../kizunasync'

export interface IUseIdentityRecoveryParams {
  client: IKizunaSyncShim
  syncNow: () => Promise<void>
  onMessage: (message: string) => void
}

export function useIdentityRecovery({ client, syncNow, onMessage }: IUseIdentityRecoveryParams): void {
  const unsubscribe = resetOnIdentityChange({
    client,
    reset: () => client.reset(),
    sync: syncNow,
    keepQueuedWrites: true,
    onRecovered: () => {
      onMessage(IDENTITY_RECOVERED_MESSAGE)
    },
    onFailed: (cause) => {
      onMessage(messageOf(cause))
    },
  })

  onScopeDispose(unsubscribe)
}
