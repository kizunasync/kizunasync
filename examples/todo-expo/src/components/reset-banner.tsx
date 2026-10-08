import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ESoftBlockReason, type TSoftBlockReason } from 'kizunasync'
import { SPACING } from '@kizunasync/ui'
import { EThemeColor } from '../theme'

// MARK: - Reset banner

/**
 * `needsReset` is `checkpoint.softBlocked`: nothing syncs again until `reset()`
 * rehydrates the local database. The server refused this client, or the local
 * data belongs to another user than the signed-in one (`identity_changed`,
 * which the board resets on its own while nothing is queued). A queued write
 * is lost with the local database, which is why the copy says so before the
 * button does it.
 */
export function ResetBanner({
  softBlockReason,
  outboxDepth,
  isResetting,
  onReset,
}: {
  softBlockReason: TSoftBlockReason | null
  outboxDepth: number
  isResetting: boolean
  onReset: () => void
}) {
  const blockedText =
    softBlockReason === ESoftBlockReason.identityChanged
      ? "This device's local data belongs to another user than the one signed in, so nothing syncs until it is rebuilt."
      : 'The server refused this client, so nothing syncs until the local database is rebuilt.'

  return (
    <View accessibilityRole="alert" style={styles.banner}>
      <Text style={styles.title}>Sync is blocked</Text>
      <Text style={styles.body}>
        {`${blockedText}${
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
