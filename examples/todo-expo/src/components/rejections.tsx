import { useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import type { TRejectionRecord, TUuid } from 'kizunasync'
import { RADIUS } from '@kizunasync/ui'
import { EThemeColor } from '../theme'
import { JournalList } from './journal-list'

/**
 * The durable rejection journal's UI surface: a header chip carrying the count
 * and a sheet listing what the server refused. Entries survive reloads until
 * dismissed, so this is where a lost write goes to be explained. The sheet
 * itself (title, rows, row renderer, dismiss, empty state) is `JournalList`,
 * shared with `overwrites.tsx` (@CONVENTIONS.md).
 */

/**
 * The count badge. Hidden while the journal is empty: nothing was refused, so
 * there is nothing to explain.
 */
export function RejectionsChip({ count, onPress }: { count: number; onPress: () => void }) {
  const [hovered, setHovered] = useState(false)

  if (count === 0) {
    return null
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Rejections"
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      hitSlop={6}
      style={[styles.chip, hovered && styles.chipHover]}
    >
      <Text style={styles.chipText}>{`⚠ ${count}`}</Text>
    </Pressable>
  )
}

export function RejectionsModal({
  visible,
  rejections,
  onDismiss,
  onClose,
}: {
  visible: boolean
  rejections: TRejectionRecord[]
  onDismiss: (mutationId: TUuid) => void
  onClose: () => void
}) {
  return (
    <JournalList
      visible={visible}
      title="Rejections"
      emptyText="No rejections. Writes that the server refuses will appear here."
      kindColor={EThemeColor.accent}
      rows={rejections.map((rejection) => ({
        id: rejection.mutationId,
        kind: rejection.kind,
        reason: `${rejection.table} · ${rejection.reason}`,
        at: rejection.at,
      }))}
      onDismiss={onDismiss}
      onClose={onClose}
    />
  )
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderColor: EThemeColor.accent,
    backgroundColor: EThemeColor.accentSoft,
    borderRadius: RADIUS.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  chipHover: { backgroundColor: EThemeColor.surfaceElevated },
  chipText: { color: EThemeColor.accent, fontSize: 11, fontWeight: '700' },
})
