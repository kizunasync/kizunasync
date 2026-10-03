import { Pressable, Text } from 'react-native'
import type { IInspectorSnapshot, IInspectorVerdict } from 'kizunasync'
import type { IQueryLogEntry } from '@kizunasync/utilities'
import { formatInspectorVerdict, operationMessage, queuedMutationMessage, statMessage, statTitle, type TStatKey } from '../../lib/cache-inspector'
import { sharedStyles } from '../../shared-styles'
import { AppModal } from '../app-modal'

/**
 * One shared dialog renders whichever of these detail kinds is selected.
 */
export type TCacheDetail =
  | { kind: 'stat'; stat: TStatKey; value: string }
  | { kind: 'queued'; entry: IInspectorSnapshot['queued'][number] }
  | { kind: 'operation'; entry: IQueryLogEntry }
  | { kind: 'verdict'; verdict: IInspectorVerdict }

/** The tap-to-explain dialog for the web Cache screen's rows; null renders nothing. */
export function CacheDetailModal({ detail, onClose }: { detail: TCacheDetail | null; onClose: () => void }) {
  if (detail === null) {
    return null
  }
  const explained = explainDetail(detail)

  return (
    <AppModal
      visible
      title={explained.title}
      onDismiss={onClose}
      actions={
        <Pressable style={sharedStyles.modalButton} onPress={onClose}>
          <Text style={sharedStyles.modalButtonText}>Close</Text>
        </Pressable>
      }
    >
      <Text style={sharedStyles.modalBody}>{explained.body}</Text>
    </AppModal>
  )
}

// MARK: - internal

/**
 * The dialog copy for a selection. The words are the shared cache-inspector
 * module's, so both renderings of this screen explain a row the same way.
 */
function explainDetail(detail: TCacheDetail): { title: string; body: string } {
  switch (detail.kind) {
    case 'stat':
      return { title: statTitle(detail.stat), body: statMessage(detail.stat, detail.value) }
    case 'queued':
      return { title: 'Queued mutation', body: queuedMutationMessage(detail.entry) }
    case 'operation':
      return { title: 'Operation', body: operationMessage(detail.entry) }
    case 'verdict':
      return { title: 'Verdict', body: formatInspectorVerdict(detail.verdict) }
    default:
      return assertNever(detail)
  }
}

/**
 * Exhaustiveness guard: a new detail kind fails to narrow to `never` here, so
 * the dialog cannot open on something it has no words for.
 */
function assertNever(value: never): never {
  throw new Error(`explainDetail: unhandled cache detail ${JSON.stringify(value)}`)
}
