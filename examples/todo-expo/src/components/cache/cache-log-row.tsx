import { Pressable, StyleSheet, Text } from 'react-native'
import type { IQueryLogEntry } from '@kizunasync/utilities'
import { RADIUS, SPACING } from '@kizunasync/ui'
import { OP_COLOR } from '../../lib/cache-inspector'
import { EThemeColor } from '../../theme'

/** One operation row on the web Cache screen (the query log's ring). */
export function CacheLogRow({ entry, onPress }: { entry: IQueryLogEntry; onPress: () => void }) {
  return (
    <Pressable style={styles.logRow} onPress={onPress}>
      <Text style={[styles.opBadge, { backgroundColor: OP_COLOR[entry.op] }]}>{entry.op}</Text>
      <Text style={styles.logLabel} numberOfLines={1}>
        {entry.label}
      </Text>
      <Text style={styles.logMeta}>
        {entry.rows === null ? 'n/a' : `${entry.rows}r`} · {entry.ms}ms
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  logRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING[2],
    minWidth: 0,
    backgroundColor: EThemeColor.surface,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  opBadge: {
    color: EThemeColor.accentForeground,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: RADIUS.md,
    flexShrink: 0,
    overflow: 'hidden',
  },
  logLabel: { color: EThemeColor.text, fontSize: 12, fontWeight: '600', flex: 1, flexShrink: 1, minWidth: 0 },
  logMeta: { color: EThemeColor.muted, fontSize: 11, flexShrink: 0 },
})
