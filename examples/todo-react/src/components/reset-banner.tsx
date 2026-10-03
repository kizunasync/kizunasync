import { Button } from '@heroui/react'

// MARK: - Reset banner

/**
 * `needsReset` is `checkpoint.softBlocked`: the server refused this client, and
 * nothing syncs again until `reset()` rehydrates it. That is the only engine
 * state an app cannot recover from on its own, so it gets a banner with the
 * action rather than a line in the status text. A queued write is lost with the
 * local database, which is why the copy says so before the button does it.
 */
export function ResetBanner({
  needsReset,
  outboxDepth,
  isResetting,
  onReset,
}: {
  needsReset: boolean
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
        The server refused this client, so nothing syncs until the local database is rebuilt.
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
