import { Button, Modal } from '@heroui/react'
import { t } from '../i18n'
import { AppModalFooter } from './app-modal-footer'

// MARK: - Switch guard modal

/**
 * Shown when a switch finds a non-empty outbox, at the request or again after
 * the sync it ran first: sync now then switch, switch anyway (losing the
 * queued outbox on reset), or cancel.
 */
export function SwitchGuardModal({
  isSyncing,
  onSyncThenSwitch,
  onSwitchAnyway,
  onCancel,
}: {
  isSyncing: boolean
  onSyncThenSwitch: () => void
  onSwitchAnyway: () => void
  onCancel: () => void
}) {
  return (
    <Modal.Root isOpen onOpenChange={(open) => (open ? undefined : onCancel())}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog role="alertdialog">
            <Modal.Heading>Unsynced changes</Modal.Heading>
            <Modal.Body>{t('warning.accountSwitch')}</Modal.Body>
            <AppModalFooter>
              <Button isDisabled={isSyncing} onPress={onSyncThenSwitch}>
                {isSyncing ? t('sync.syncing') : t('sync.now')}
              </Button>
              <Button variant="danger-soft" onPress={onSwitchAnyway}>
                Switch anyway
              </Button>
              <Button variant="outline" onPress={onCancel}>
                Cancel
              </Button>
            </AppModalFooter>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  )
}
