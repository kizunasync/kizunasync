import { StyleSheet, Text, View } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../theme'
import { sharedStyles } from '../shared-styles'
import { SkeletonList } from './skeleton'
import { t } from '../i18n'

/**
 * Placeholder rows while the first load runs, the onboarding note when the
 * board itself is empty, and a plain "no match" line when only the filter
 * emptied it. The onboarding note would claim the board is empty in that
 * last case.
 */
export function BoardPlaceholder({ showSkeleton, boardEmpty }: { showSkeleton: boolean; boardEmpty: boolean }) {
  if (showSkeleton) {
    return (
      <View style={sharedStyles.column}>
        <SkeletonList />
      </View>
    )
  }
  if (!boardEmpty) {
    return (
      <View style={sharedStyles.column}>
        <Text style={styles.noMatch}>No todos match.</Text>
      </View>
    )
  }
  return (
    <View style={sharedStyles.column}>
      <View style={styles.empty}>
        <Text style={styles.emptyGlyph}>絆</Text>
        <Text style={styles.emptyTitle}>{t('empty.title')}</Text>
        <Text style={styles.emptyHint}>{t('empty.hint')}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  noMatch: { color: EThemeColor.muted, fontSize: 12, textAlign: 'center', paddingVertical: 28 },
  empty: { alignItems: 'center', paddingVertical: SPACING[12], gap: 6 },
  emptyGlyph: { color: EThemeColor.accent, fontSize: 32, opacity: 0.5, marginBottom: SPACING[1] },
  emptyTitle: { color: EThemeColor.muted, fontSize: 15, fontWeight: '600' },
  emptyHint: { color: EThemeColor.muted, fontSize: 12, textAlign: 'center', lineHeight: 17, maxWidth: 280 },
})
