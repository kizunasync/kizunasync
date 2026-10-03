import { StyleSheet, View } from 'react-native'
import { RADIUS } from '@kizunasync/ui'
import { EThemeColor } from '../theme'

/**
 * The pill-track-plus-knob toggle visual, shared by `SyncBar`'s trailing
 * switch and the web Settings screen's `ToggleRow`. Presentational only: the
 * caller's own Pressable owns the tap (@CONVENTIONS.md).
 */
export function ToggleSwitch({ value }: { value: boolean }) {
  return (
    <View style={[styles.switch, value && styles.switchOn]}>
      <View style={[styles.switchKnob, value && styles.switchKnobOn]} />
    </View>
  )
}

const styles = StyleSheet.create({
  switch: {
    width: 44,
    height: 26,
    borderRadius: RADIUS.full,
    padding: 3,
    backgroundColor: EThemeColor.border,
    justifyContent: 'center',
  },
  switchOn: { backgroundColor: EThemeColor.accent },
  switchKnob: {
    width: 20,
    height: 20,
    borderRadius: RADIUS.full,
    backgroundColor: EThemeColor.accentForeground,
  },
  switchKnobOn: { transform: [{ translateX: 18 }] },
})
