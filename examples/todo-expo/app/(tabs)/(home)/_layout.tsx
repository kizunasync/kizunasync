import { Linking, Pressable, StyleSheet, Text } from 'react-native'
import { Stack } from 'expo-router'
import { stackHeaderOptions } from '../../../src/lib/stack-layout'
import { EThemeColor } from '../../../src/theme'

const SITE_URL = 'https://kizunasync.com'

/**
 * Native Stack for the TODO tab. The header options are the shared
 * `stackHeaderOptions` (@src/lib/stack-layout.ts). The red 絆 rides in
 * headerLeft (top-left, above the large title): the system large title is a
 * single-color label and cannot take a two-tone kanji. Tapping it opens the
 * Kizuna Sync site. `_layout.web.tsx` renders a bare Slot; the web segmented
 * nav owns the chrome.
 */
export default function HomeStackLayout() {
  return (
    <Stack
      screenOptions={stackHeaderOptions(() => (
        <Pressable
          onPress={() => void Linking.openURL(SITE_URL)}
          hitSlop={8}
          accessibilityRole="link"
          accessibilityLabel="Open kizunasync.com"
        >
          <Text style={styles.mark}>絆</Text>
        </Pressable>
      ))}
    >
      <Stack.Screen name="index" options={{ title: 'Kizuna Sync' }} />
    </Stack>
  )
}

const styles = StyleSheet.create({
  mark: { color: EThemeColor.accent, fontSize: 24, fontWeight: '700' },
})
