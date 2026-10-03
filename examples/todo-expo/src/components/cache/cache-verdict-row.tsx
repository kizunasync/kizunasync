import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { IInspectorVerdict } from 'kizunasync'
import { RADIUS, SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../../theme'

/** One rejected/aborted/overwritten verdict row on the web Cache screen. */
export function CacheVerdictRow({ verdict, onPress }: { verdict: IInspectorVerdict; onPress: () => void }) {
  return (
    <Pressable style={styles.verdictRow} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={styles.verdictChip}>
          <Text style={styles.verdictKind}>{verdict.kind}</Text>
        </View>
        <Text style={styles.verdictId} numberOfLines={1}>
          {verdict.mutationId}
        </Text>
      </View>
      <Text style={styles.verdictReason}>{verdict.reason}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  verdictRow: {
    backgroundColor: EThemeColor.panel,
    borderWidth: 1,
    borderColor: EThemeColor.panelBorder,
    borderRadius: 11,
    padding: 13,
    gap: 6,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: SPACING[2] },
  verdictChip: {
    backgroundColor: EThemeColor.accentSoft,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING[2],
    paddingVertical: 2,
  },
  verdictKind: {
    color: EThemeColor.accent,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  verdictId: { color: EThemeColor.muted, fontSize: 11, flex: 1 },
  verdictReason: { color: EThemeColor.text, fontSize: 12, lineHeight: 17 },
})
