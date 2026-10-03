import { useEffect, useRef } from 'react'
import { AccessibilityInfo, Animated, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native'
import { RADIUS as tokenRadius, SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../theme'
import { MAX_WIDTH } from '../layout-constants'

/**
 * A pulsing placeholder block. Opacity loops via the native driver (works on
 * native and on react-native-web); reduce-motion holds it static. The caller
 * sizes it to match the real element it stands in for.
 */
export function Skeleton({
  width = '100%',
  height,
  radius = 8,
  style,
}: {
  width?: DimensionValue
  height: DimensionValue
  radius?: number
  style?: StyleProp<ViewStyle>
}) {
  const opacity = useRef(new Animated.Value(0.5)).current

  useEffect(() => {
    let cancelled = false
    let loop: Animated.CompositeAnimation | null = null

    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) {
        return
      }
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 1, duration: 650, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.5, duration: 650, useNativeDriver: true }),
        ]),
      )
      loop.start()
    })

    return () => {
      cancelled = true
      loop?.stop()
    }
  }, [opacity])

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: EThemeColor.borderStrong, opacity },
        style,
      ]}
    />
  )
}

/** A 38×38 row thumbnail placeholder (matches styles.thumb in the home screen). */
export function SkeletonThumb() {
  return <Skeleton width={38} height={38} radius={7} />
}

/** One placeholder row mirroring a todo row: checkbox, thumb, title bar, badge. */
function SkeletonRow() {
  return (
    <View style={styles.row}>
      <Skeleton width={21} height={21} radius={tokenRadius.md} />
      <SkeletonThumb />
      <Skeleton height={14} radius={5} style={styles.title} />
      <Skeleton width={46} height={18} radius={tokenRadius.full} />
    </View>
  )
}

/** A short stack of placeholder rows shown while the first load/pull is pending. */
export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <View style={styles.list}>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </View>
  )
}

/**
 * The whole-board placeholder shown while the client is still booting: the add
 * row's bar plus a short list, in the screen's centered column.
 */
export function SkeletonBoard() {
  return (
    <View style={styles.board}>
      <Skeleton width="100%" height={46} radius={11} />
      <SkeletonList />
    </View>
  )
}

const styles = StyleSheet.create({
  board: {
    width: '100%',
    maxWidth: MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: SPACING[4],
    paddingTop: SPACING[4],
    gap: SPACING[2],
  },
  list: { gap: SPACING[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 13,
    borderRadius: tokenRadius.xl,
    borderWidth: 1,
    borderColor: EThemeColor.hairline,
    backgroundColor: EThemeColor.surfaceElevated,
  },
  title: { flex: 1 },
})
