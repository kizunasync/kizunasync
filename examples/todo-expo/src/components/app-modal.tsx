import type { ReactNode } from 'react'
import { Modal } from 'react-native'
import { ModalShell } from './modal-shell'

/**
 * Every dialog in this app: the react-native Modal presentation welded to the
 * ModalShell card, so no caller can drift on transparency, the fade, the
 * status-bar overlay, or the Android hardware-back handler. Callers own only
 * what the dialog says and what its buttons do; `onDismiss` serves both the
 * scrim tap and the back gesture.
 */
export function AppModal({
  visible,
  title,
  children,
  actions,
  onDismiss,
}: {
  visible: boolean
  title: string
  children: ReactNode
  actions: ReactNode
  onDismiss: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onDismiss}>
      <ModalShell title={title} actions={actions} onDismiss={onDismiss}>
        {children}
      </ModalShell>
    </Modal>
  )
}
