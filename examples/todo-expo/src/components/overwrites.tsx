import { useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import type { TOverwriteRecord } from '@kizunasync/core'
import { RADIUS } from '@kizunasync/ui'
import { EThemeColor } from '../theme'
import { JournalList } from './journal-list'

/**
 * The durable overwrite journal's UI surface, the twin of `rejections.tsx`. A
 * rejection is a write the server refused; an overwrite is a write it accepted
 * whose column another device had already won. Entries survive reloads until
 * dismissed, so this is where a value that changed under the user goes to be
 * explained. The sheet itself (title, rows, row renderer, dismiss, empty
 * state) is `JournalList` (@CONVENTIONS.md).
 */

/** A column value is any JSON, and a long one would swamp the row. */
const LOSER_VALUE_MAX_LENGTH = 60

function describeLoser(value: unknown): string {
  if (value === null || value === undefined) {
    return 'an empty value'
  }
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)

  if (rendered === undefined || rendered.length > LOSER_VALUE_MAX_LENGTH) {
    return 'your value'
  }
  return `"${rendered}"`
}

/** The overwrite count badge, rendered only while the journal carries entries. */
export function OverwritesChip({ count, onPress }: { count: number; onPress: () => void }) {
  const [hovered, setHovered] = useState(false)

  if (count === 0) {
    return null
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Overwrites"
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      hitSlop={6}
      style={[styles.chip, hovered && styles.chipHover]}
    >
      <Text style={styles.chipText}>{`⇄ ${count}`}</Text>
    </Pressable>
  )
}

export function OverwritesModal({
  visible,
  overwrites,
  onDismiss,
  onClose,
}: {
  visible: boolean
  overwrites: TOverwriteRecord[]
  onDismiss: (id: number) => void
  onClose: () => void
}) {
  return (
    <JournalList
      visible={visible}
      title="Overwrites"
      emptyText="No overwrites. Columns another device wins will appear here."
      kindColor={EThemeColor.muted}
      rows={overwrites.map((overwrite) => ({
        id: overwrite.id,
        kind: overwrite.conflictMode,
        reason: `${overwrite.table}.${overwrite.column} · another device won, so ${describeLoser(overwrite.loserValue)} was replaced`,
        at: overwrite.at,
      }))}
      onDismiss={onDismiss}
      onClose={onClose}
    />
  )
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderColor: EThemeColor.border,
    backgroundColor: EThemeColor.surfaceElevated,
    borderRadius: RADIUS.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  chipHover: { backgroundColor: EThemeColor.surface },
  chipText: { color: EThemeColor.muted, fontSize: 11, fontWeight: '700' },
})
