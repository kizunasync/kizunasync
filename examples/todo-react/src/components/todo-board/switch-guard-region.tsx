import { SwitchGuardModal } from '../switch-guard-modal'

// MARK: - Switch guard region

/** Raised when requestSwitch finds a non-empty outbox. */
export function SwitchGuardRegion({
  isPending,
  isSyncing,
  onSyncThenSwitch,
  onSwitchAnyway,
  onCancel,
}: {
  isPending: boolean
  isSyncing: boolean
  onSyncThenSwitch: () => void
  onSwitchAnyway: () => void
  onCancel: () => void
}) {
  if (!isPending) {
    return null
  }
  return (
    <SwitchGuardModal
      isSyncing={isSyncing}
      onSyncThenSwitch={onSyncThenSwitch}
      onSwitchAnyway={onSwitchAnyway}
      onCancel={onCancel}
    />
  )
}
