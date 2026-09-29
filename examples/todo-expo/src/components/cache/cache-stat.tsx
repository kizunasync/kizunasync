import { Pressable, StyleSheet, Text } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../../theme'

/** One outbox-depth/cursor/last-mutation-id tile on the web Cache screen. */
export function CacheStat({
  label,
  value,
  full,
  onPress,
}: {
  label: string
  value: string
  full?: boolean
  onPress?: () => void
}) {
  return (
    <Pressable style={[styles.stat, full === true && styles.statFull]} onPress={onPress}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  stat: {
    flex: 1,
    backgroundColor: EThemeColor.surfaceElevated,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    borderRadius: 11,
    padding: 13,
  },
  statFull: { flex: 0 },
  statLabel: {
    color: EThemeColor.muted,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: SPACING[1],
  },
  statValue: { color: EThemeColor.text, fontSize: 14, fontWeight: '600' },
})
