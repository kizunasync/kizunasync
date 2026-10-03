import { useState } from 'react'
import { expireCheckpoint, forceServerConflict, resetLocal } from '../kizunasync-shim'

/**
 * The Settings screen's edge-case lab: force a server conflict, expire the
 * checkpoint, or wipe the local database, each reporting through `message`.
 * Shared by the native and web Settings screens, which render the three
 * actions through their own platform buttons (@CONVENTIONS.md).
 */
export interface ISettingsLab {
  message: string | null
  onForceConflict: () => void
  onExpireCheckpoint: () => void
  onResetLocal: () => void
}

export function useSettingsLab(): ISettingsLab {
  const [message, setMessage] = useState<string | null>(null)

  return {
    message,
    onForceConflict: () => {
      void forceServerConflict().then(setMessage)
    },
    onExpireCheckpoint: () => {
      expireCheckpoint()
      setMessage('cursor rewound, next sync re-walks history')
    },
    onResetLocal: () => {
      void resetLocal().then(() => setMessage('local wiped, sync to re-hydrate the RLS-visible rows'))
    },
  }
}
