import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { IInspectorSnapshot } from '@kizunasync/core'
import { RADIUS, SPACING } from '@kizunasync/ui'
import { QUEUE_OP_COLOR } from '../../lib/cache-inspector'
import { EThemeColor } from '../../theme'

/** One queued-mutation row on the web Cache screen. */
export function CacheQueueRow({ entry, onPress }: { entry: IInspectorSnapshot['queued'][number]; onPress: () => void }) {
  return (
    <Pressable style={styles.queueRow} onPress={onPress}>
      <View style={styles.rowHead}>
        <Text style={[styles.opBadge, { backgroundColor: QUEUE_OP_COLOR[entry.op] ?? EThemeColor.faint }]}>
          {entry.op}
        </Text>
        <Text style={styles.queueTable}>{entry.table}</Text>
        {entry.inFlight ? (
          <View style={styles.inFlightChip}>
            <Text style={styles.inFlight}>in-flight</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.queuePk} numberOfLines={1}>
        pk {entry.pk}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  queueRow: {
    backgroundColor: EThemeColor.surface,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    borderRadius: 11,
    padding: 13,
    gap: 6,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: SPACING[2] },
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
  queueTable: { color: EThemeColor.text, fontSize: 13, fontWeight: '600', flex: 1 },
  inFlightChip: {
    borderWidth: 1,
    borderColor: EThemeColor.success,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING[2],
    paddingVertical: 2,
  },
  inFlight: { color: EThemeColor.success, fontSize: 10, fontWeight: '700' },
  queuePk: { color: EThemeColor.muted, fontSize: 11 },
})
