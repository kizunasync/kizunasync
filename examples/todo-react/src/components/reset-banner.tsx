import { Button } from '@heroui/react'
import { ESoftBlockReason, type TSoftBlockReason } from 'kizunasync'

// MARK: - Reset banner

/**
 * `needsReset` is `checkpoint.softBlocked`: nothing syncs again until `reset()`
 * rehydrates the local database. The server refused this client, or the local
 * data belongs to another user than the signed-in one (`identity_changed`,
 * which the board resets on its own while nothing is queued). A queued write
 * is lost with the local database, which is why the copy says so before the
 * button does it.
 */
export function ResetBanner({
  needsReset,
  softBlockReason,
  outboxDepth,
  isResetting,
  onReset,
}: {
  needsReset: boolean
  softBlockReason: TSoftBlockReason | null
  outboxDepth: number
  isResetting: boolean
  onReset: () => void
}) {
  if (!needsReset) {
    return null
  }
  return (
    <div className="reset-banner" role="alert">
      <p className="reset-banner-title">Sync is blocked</p>
      <p className="reset-banner-body">
        {softBlockReason === ESoftBlockReason.identityChanged
          ? "This device's local data belongs to another user than the one signed in, so nothing syncs until it is rebuilt."
          : 'The server refused this client, so nothing syncs until the local database is rebuilt.'}
        {outboxDepth > 0
          ? ` ${outboxDepth} unsynced ${outboxDepth === 1 ? 'write' : 'writes'} will be lost.`
          : ''}
      </p>
      <Button variant="primary" size="sm" isDisabled={isResetting} onPress={onReset}>
        {isResetting ? 'Resetting' : 'Reset local data'}
      </Button>
    </div>
  )
}
