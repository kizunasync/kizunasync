import { useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { RADIUS } from '@kizunasync/ui'
import { EThemeColor } from '../theme'

/**
 * One option in a segmented control: the web tab bar, the todo filter, and the
 * cache log filter all draw this. Fully round, like the account chips: the pill
 * is the family's shape for "pick one of these". The caller owns which option is
 * selected and what selecting it does.
 *
 * `size` is geometry only: `md` for the standalone controls, `sm` where the
 * segment rides inside a section header. `grow` fills the track and belongs to
 * the compact bottom nav alone; every other site sizes to its content.
 */
type TSegmentPillSize = 'sm' | 'md'

export function SegmentPill({
  label,
  glyph,
  active,
  size = 'md',
  grow = false,
  onPress,
}: {
  label: string
  glyph?: string
  active: boolean
  size?: TSegmentPillSize
  grow?: boolean
  onPress: () => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={pillStyle({ size, grow, hovered, active })}
    >
      {glyph === undefined ? null : (
        <Text style={[styles.glyph, active && styles.labelActive]}>{glyph}</Text>
      )}
      <Text style={[styles.label, size === 'sm' ? styles.labelSmall : styles.labelMedium, active && styles.labelActive]}>
        {label}
      </Text>
    </Pressable>
  )
}

// MARK: - internal

function pillStyle({
  size,
  grow,
  hovered,
  active,
}: {
  size: TSegmentPillSize
  grow: boolean
  hovered: boolean
  active: boolean
}) {
  return [
    styles.pill,
    size === 'sm' ? styles.pillSmall : styles.pillMedium,
    grow && styles.pillGrow,
    hovered && !active && styles.pillHover,
    active && styles.pillActive,
  ]
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: EThemeColor.border,
  },
  pillSmall: { paddingHorizontal: 11, paddingVertical: 5 },
  pillMedium: { paddingHorizontal: 14, paddingVertical: 7 },
  pillGrow: { flex: 1 },
  pillHover: { backgroundColor: EThemeColor.surfaceElevated },
  pillActive: { backgroundColor: EThemeColor.accent, borderColor: EThemeColor.accent },

  glyph: { color: EThemeColor.muted, fontSize: 12, fontWeight: '700' },
  label: { color: EThemeColor.muted, fontWeight: '700' },
  labelSmall: { fontSize: 11 },
  labelMedium: { fontSize: 13 },
  labelActive: { color: EThemeColor.accentForeground },
})
