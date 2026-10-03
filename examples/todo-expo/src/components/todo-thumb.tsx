import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { useAttachment } from 'kizunasync/react'
import { EThemeColor } from '../theme'
import { SkeletonThumb } from './skeleton'

/**
 * A row's image. The attachment port lazy-fetches a peer's bytes on first
 * view. A pending thumb shows the placeholder; a failed one shows nothing.
 *
 * Only a reference the transfer budget stopped for good is actionable in the
 * row: retry (forgive the budget and fetch again) and remove (forget the
 * reference and its bytes). Every other failure is retried by the next sync
 * on its own.
 */
export function TodoThumb({ imagePath }: { imagePath: string | null }) {
  const { localUri, error, permanent, attempts, retry, remove } = useAttachment(imagePath)

  if (imagePath === null) {
    return null
  }
  if (permanent) {
    return (
      <View style={styles.stopped}>
        <Text style={styles.stoppedText} numberOfLines={1}>
          {`Image stopped after ${attempts} ${attempts === 1 ? 'try' : 'tries'}`}
        </Text>
        <View style={styles.stoppedActions}>
          <Pressable accessibilityRole="button" hitSlop={6} onPress={retry}>
            <Text style={styles.stoppedAction}>Retry</Text>
          </Pressable>
          <Pressable accessibilityRole="button" hitSlop={6} onPress={remove}>
            <Text style={styles.stoppedAction}>Remove</Text>
          </Pressable>
        </View>
      </View>
    )
  }
  if (localUri === null) {
    return error === null ? <SkeletonThumb /> : null
  }
  return <Image source={{ uri: localUri }} style={styles.thumb} />
}

const styles = StyleSheet.create({
  thumb: { width: 38, height: 38, borderRadius: 7, flexShrink: 0 },
  stopped: {
    flexShrink: 0,
    maxWidth: 148,
    gap: 2,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: EThemeColor.border,
    borderRadius: 7,
    borderCurve: 'continuous',
  },
  stoppedText: { color: EThemeColor.muted, fontSize: 10 },
  stoppedActions: { flexDirection: 'row', gap: 10 },
  stoppedAction: { color: EThemeColor.accent, fontSize: 11, fontWeight: '700' },
})
