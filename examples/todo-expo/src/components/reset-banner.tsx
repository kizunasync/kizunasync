import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../theme'

// MARK: - Reset banner

/**
 * `needsReset` is `checkpoint.softBlocked`: the server refused this client, and
 * nothing syncs again until `reset()` rehydrates it. That is the only engine
 * state an app cannot recover from on its own, so it gets a banner with the
 * action rather than a line in the status text. A queued write is lost with the
 * local database, which is why the copy says so before the button does it.
 */
export function ResetBanner({
  outboxDepth,
  isResetting,
  onReset,
}: {
  outboxDepth: number
  isResetting: boolean
  onReset: () => void
}) {
  return (
    <View accessibilityRole="alert" style={styles.banner}>
      <Text style={styles.title}>Sync is blocked</Text>
      <Text style={styles.body}>
        {`The server refused this client, so nothing syncs until the local database is rebuilt.${
          outboxDepth > 0
            ? ` ${outboxDepth} unsynced ${outboxDepth === 1 ? 'write' : 'writes'} will be lost.`
            : ''
        }`}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={isResetting}
        onPress={onReset}
        style={styles.button}
      >
        <Text style={styles.buttonText}>{isResetting ? 'Resetting' : 'Reset local data'}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    gap: 6,
    marginBottom: SPACING[3],
    padding: SPACING[3],
    borderWidth: 1,
    borderColor: EThemeColor.danger,
    borderRadius: 11,
    borderCurve: 'continuous',
    backgroundColor: EThemeColor.surface,
    alignItems: 'flex-start',
  },
  title: { color: EThemeColor.danger, fontSize: 13, fontWeight: '700' },
  body: { color: EThemeColor.muted, fontSize: 12, lineHeight: 17 },
  button: {
    marginTop: 2,
    paddingHorizontal: SPACING[3],
    paddingVertical: 7,
    borderRadius: 9,
    borderCurve: 'continuous',
    backgroundColor: EThemeColor.accent,
  },
  buttonText: { color: EThemeColor.accentForeground, fontSize: 12, fontWeight: '700' },
})
