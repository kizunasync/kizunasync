import { Pressable, Text } from 'react-native'
import type { TAccountKey } from '../lib/account'
import { sharedStyles } from '../shared-styles'
import { AppModal } from './app-modal'
import { t } from '../i18n'

/**
 * The switch the user asked for while the outbox still held writes: the target
 * account and how many queued writes a wipe would drop.
 */
export interface IPendingSwitch {
  key: TAccountKey
  label: string
  depth: number
}

export function SwitchGuardModal({
  pending,
  onSyncNow,
  onSwitchAnyway,
  onCancel,
}: {
  pending: IPendingSwitch | null
  onSyncNow: () => void
  onSwitchAnyway: () => void
  onCancel: () => void
}) {
  return (
    <AppModal
      visible={pending !== null}
      title="Unsynced changes"
      onDismiss={onCancel}
      actions={
        <>
          <Pressable style={[sharedStyles.modalButton, sharedStyles.modalButtonPrimary]} onPress={onSyncNow}>
            <Text style={sharedStyles.modalButtonPrimaryText}>{t('sync.now')}</Text>
          </Pressable>
          <Pressable style={sharedStyles.modalButton} onPress={onSwitchAnyway}>
            <Text style={sharedStyles.modalButtonDangerText}>Switch anyway</Text>
          </Pressable>
          <Pressable style={sharedStyles.modalButton} onPress={onCancel}>
            <Text style={sharedStyles.modalButtonText}>Cancel</Text>
          </Pressable>
        </>
      }
    >
      <Text style={sharedStyles.modalBody}>{t('warning.accountSwitch')}</Text>
    </AppModal>
  )
}
