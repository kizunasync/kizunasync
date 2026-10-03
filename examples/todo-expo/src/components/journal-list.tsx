import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { formatRelativeTime } from '@kizunasync/utilities'
import { EThemeColor } from '../theme'
import { sharedStyles } from '../shared-styles'
import { AppModal } from './app-modal'

/**
 * The dismissible-journal sheet shared by `overwrites.tsx` and
 * `rejections.tsx`: a title, a list of rows (kind, reason, relative time,
 * dismiss), and an empty state. Each caller maps its own record type into
 * `IJournalRow` and supplies the kind label's color, since overwrites and
 * rejections tint it differently (@CONVENTIONS.md).
 */
export interface IJournalRow<TId extends string | number> {
  id: TId
  kind: string
  reason: string
  at: number
}

export function JournalList<TId extends string | number>({
  visible,
  title,
  emptyText,
  kindColor,
  rows,
  onDismiss,
  onClose,
}: {
  visible: boolean
  title: string
  emptyText: string
  kindColor: string
  rows: IJournalRow<TId>[]
  onDismiss: (id: TId) => void
  onClose: () => void
}) {
  return (
    <AppModal
      visible={visible}
      title={title}
      onDismiss={onClose}
      actions={
        <Pressable style={sharedStyles.modalButton} onPress={onClose}>
          <Text style={sharedStyles.modalButtonText}>Close</Text>
        </Pressable>
      }
    >
      {rows.length === 0 ? (
        <Text style={sharedStyles.modalBody}>{emptyText}</Text>
      ) : (
        <View>
          {rows.map((row) => (
            <JournalRow key={row.id} row={row} kindColor={kindColor} onDismiss={onDismiss} />
          ))}
        </View>
      )}
    </AppModal>
  )
}

// MARK: - Pieces

function JournalRow<TId extends string | number>({
  row,
  kindColor,
  onDismiss,
}: {
  row: IJournalRow<TId>
  kindColor: string
  onDismiss: (id: TId) => void
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={[styles.rowKind, { color: kindColor }]}>{row.kind}</Text>
        <Text style={styles.rowReason} numberOfLines={2}>
          {row.reason}
        </Text>
        <Text style={styles.rowTime}>{formatRelativeTime(row.at)}</Text>
      </View>
      <Pressable style={styles.dismissButton} onPress={() => onDismiss(row.id)}>
        <Text style={styles.dismissText}>Dismiss</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: EThemeColor.hairline,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowKind: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  rowReason: { color: EThemeColor.muted, fontSize: 12, lineHeight: 17 },
  rowTime: { color: EThemeColor.muted, fontSize: 11 },
  dismissButton: {
    borderWidth: 1,
    borderColor: EThemeColor.border,
    borderRadius: 9,
    borderCurve: 'continuous',
    paddingHorizontal: SPACING[3],
    paddingVertical: 7,
    backgroundColor: 'transparent',
  },
  dismissText: { color: EThemeColor.muted, fontSize: 12, fontWeight: '700' },
})
