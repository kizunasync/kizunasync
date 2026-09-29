import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../theme'
import { MAX_WIDTH } from '../layout-constants'

/**
 * The ScrollView + centered column wrapper shared by the react-native-web
 * screens (the web tab layout owns the page chrome, so this is the ROOT,
 * no SafeAreaView). Insets are tokenized from @kizunasync/ui's spacing scale, never
 * a raw pixel literal.
 */
export function WebScreenShell({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.scroll}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.column}>{children}</View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: EThemeColor.background },
  scroll: { paddingTop: SPACING[0], paddingBottom: SPACING[6] },
  column: {
    width: '100%',
    maxWidth: MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: SPACING[4],
    gap: SPACING[3],
  },
})
